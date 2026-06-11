/**
 * cnpj.js — validação profissional de CNPJ.
 *
 * Três responsabilidades:
 *  1. Validação SINTÁTICA offline (dígitos verificadores mód 11) — barata, roda
 *     antes de qualquer chamada de rede e elimina ~100% dos 14 dígitos aleatórios.
 *  2. Regras de NEGÓCIO sobre o CNAE (allowlist de atividades de educação física).
 *  3. Consulta CADASTRAL na Receita via cadeia de provedores com fallback
 *     (BrasilAPI → CNPJá → ReceitaWS), normalizando o shape de cada um.
 *
 * A consulta lança erros tipados ({ code }) para a rota traduzir em HTTP:
 *   - NOT_FOUND   → CNPJ não existe na base da Receita (404 limpo, sem fallback)
 *   - UNAVAILABLE → todos os provedores falharam por erro transitório (timeout/5xx)
 */
const axios = require("axios");

// ─── Validação sintática (dígitos verificadores) ────────────────────────────────
function onlyDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * Valida os dígitos verificadores do CNPJ (mód 11). Hoje só numérico; a função
 * já isola a limpeza para facilitar a futura adoção do CNPJ alfanumérico (2026).
 */
function isValidCNPJ(raw) {
  const c = onlyDigits(raw);
  if (c.length !== 14) return false;
  // Rejeita sequências repetidas (00000000000000, 11111111111111, ...).
  if (/^(\d)\1{13}$/.test(c)) return false;

  const calcDigit = (len) => {
    let pos = len - 7;
    let sum = 0;
    for (let i = len; i >= 1; i--) {
      sum += Number(c[len - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };

  return calcDigit(12) === Number(c[12]) && calcDigit(13) === Number(c[13]);
}

// ─── Allowlist de CNAEs (atividade física / treinamento) ─────────────────────────
// Códigos de 7 dígitos (sem separadores). Confirme/ajuste a lista com o negócio.
const CNAES_PERMITIDOS = new Set([
  "9313100", // Atividades de condicionamento físico
  "8591100", // Ensino de esportes
  "9319199", // Outras atividades esportivas não especificadas anteriormente
  "8650004", // Atividades de fisioterapia
  "8690999", // Outras atividades de atenção à saúde humana
]);

function normalizeCnae(value) {
  // Aceita number, "9313-1/00", "93.13-1-00", etc. → 7 dígitos.
  return onlyDigits(value).slice(0, 7);
}

function cnaePermitido(codigo) {
  return CNAES_PERMITIDOS.has(normalizeCnae(codigo));
}

/** Lista de CNAEs (principal + secundários) de uma empresa normalizada. */
function cnaesDaEmpresa(empresa) {
  const lista = [];
  if (empresa.cnaePrincipal?.codigo) lista.push(normalizeCnae(empresa.cnaePrincipal.codigo));
  for (const s of empresa.cnaesSecundarios || []) {
    if (s?.codigo) lista.push(normalizeCnae(s.codigo));
  }
  return lista;
}

/** True se o CNAE escolhido consta no CNPJ (principal ou secundário). */
function cnaePertenceAoCnpj(codigoEscolhido, empresa) {
  const alvo = normalizeCnae(codigoEscolhido);
  return cnaesDaEmpresa(empresa).includes(alvo);
}

// ─── Adapters de provedores → shape normalizado único ────────────────────────────
// Shape: { razaoSocial, nomeFantasia, situacao, ativa, cnaePrincipal:{codigo,descricao},
//          cnaesSecundarios:[{codigo,descricao}], fonte }

function fromBrasilAPI(d) {
  const situacao = String(d.descricao_situacao_cadastral || "").toUpperCase();
  return {
    razaoSocial: d.razao_social || null,
    nomeFantasia: d.nome_fantasia || null,
    situacao,
    ativa: situacao === "ATIVA",
    cnaePrincipal: {
      codigo: normalizeCnae(d.cnae_fiscal),
      descricao: d.cnae_fiscal_descricao || null,
    },
    cnaesSecundarios: (d.cnaes_secundarios || []).map((s) => ({
      codigo: normalizeCnae(s.codigo),
      descricao: s.descricao || null,
    })),
    fonte: "brasilapi",
  };
}

function fromCNPJa(d) {
  const texto = String(d.status?.text || "").toUpperCase();
  return {
    razaoSocial: d.company?.name || null,
    nomeFantasia: d.alias || null,
    situacao: texto,
    ativa: texto.startsWith("ATIV"),
    cnaePrincipal: {
      codigo: normalizeCnae(d.mainActivity?.id),
      descricao: d.mainActivity?.text || null,
    },
    cnaesSecundarios: (d.sideActivities || []).map((s) => ({
      codigo: normalizeCnae(s.id),
      descricao: s.text || null,
    })),
    fonte: "cnpja",
  };
}

function fromReceitaWS(d) {
  const situacao = String(d.situacao || "").toUpperCase();
  const principal = (d.atividade_principal || [])[0] || {};
  return {
    razaoSocial: d.nome || null,
    nomeFantasia: d.fantasia || null,
    situacao,
    ativa: situacao === "ATIVA",
    cnaePrincipal: {
      codigo: normalizeCnae(principal.code),
      descricao: principal.text || null,
    },
    cnaesSecundarios: (d.atividades_secundarias || []).map((s) => ({
      codigo: normalizeCnae(s.code),
      descricao: s.text || null,
    })),
    fonte: "receitaws",
  };
}

// ─── Cadeia de consulta com fallback ─────────────────────────────────────────────
const TIMEOUT_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Erro 404 do provedor = CNPJ inexistente. Tratado como autoritativo: NÃO cai
// para o próximo provedor (evita mascarar um CNPJ realmente inválido).
function is404(err) {
  return err.response?.status === 404;
}

const PROVIDERS = [
  {
    nome: "brasilapi",
    url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`,
    adapt: fromBrasilAPI,
  },
  {
    nome: "cnpja",
    url: (c) => `https://open.cnpja.com/office/${c}`,
    adapt: fromCNPJa,
  },
  {
    nome: "receitaws",
    url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`,
    adapt: fromReceitaWS,
  },
];

/**
 * Consulta o CNPJ na cadeia de provedores.
 *  - Tenta cada provedor com 1 retry (backoff) para erros transitórios.
 *  - 404 limpo interrompe a cadeia e lança NOT_FOUND.
 *  - Se todos falharem por erro transitório, lança UNAVAILABLE.
 */
async function lookupCNPJ(raw) {
  const c = onlyDigits(raw);
  let lastError = null;

  for (const provider of PROVIDERS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await axios.get(provider.url(c), { timeout: TIMEOUT_MS });
        return provider.adapt(data);
      } catch (err) {
        if (is404(err)) {
          const e = new Error("CNPJ não encontrado na base da Receita Federal.");
          e.code = "NOT_FOUND";
          throw e;
        }
        lastError = err;
        // Backoff curto só antes do retry no mesmo provedor.
        if (attempt === 0) await sleep(400);
      }
    }
  }

  const e = new Error(
    "Não foi possível consultar a Receita Federal no momento. Tente novamente em instantes."
  );
  e.code = "UNAVAILABLE";
  e.cause = lastError?.message;
  throw e;
}

module.exports = {
  onlyDigits,
  isValidCNPJ,
  normalizeCnae,
  cnaePermitido,
  cnaePertenceAoCnpj,
  cnaesDaEmpresa,
  lookupCNPJ,
  CNAES_PERMITIDOS,
};

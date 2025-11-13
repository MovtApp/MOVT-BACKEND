# 📝 Changelog - Ajustes para Deploy na Vercel

## ✅ Arquivos Criados

### 1. `vercel.json`
Configuração principal do deploy:
- Define build do `index.js` com runtime Node.js
- Roteamento de todas as requisições para a função principal
- Referências para variáveis de ambiente

### 2. `.vercelignore`
Otimização do deploy:
- Exclui `node_modules`, `.env`, logs e arquivos desnecessários
- Reduz tamanho do bundle final

### 3. `.env.example`
Template de variáveis de ambiente necessárias

### 4. `.gitignore`
Proteção de arquivos sensíveis no Git

### 5. `DEPLOY-VERCEL.md`
Documentação completa de deploy e troubleshooting

## 🔧 Arquivos Modificados

### 1. `index.js`
**Linha 13-19**: Otimização da conexão PostgreSQL
```javascript
// ANTES
const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,  // ❌ Insuficiente para serverless
  prepare: false,
});

// DEPOIS
const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 10,           // ✅ Melhor para serverless
  idle_timeout: 20,  // ✅ Timeout de conexões ociosas
  connect_timeout: 10, // ✅ Timeout de conexão
  prepare: false,
});
```

**Linha 997-1000**: Exportação para serverless
```javascript
// ANTES
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  console.log(`Servidor também acessível via IP da rede local`);
});

// DEPOIS
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`Servidor também acessível via IP da rede local`);
  });
}

module.exports = app; // ✅ Exporta para Vercel
```

### 2. `package.json`
**Linha 7**: Adicionado script `start`
```json
"scripts": {
  "dev": "nodemon index.js",
  "start": "node index.js",  // ✅ Novo
  "test": "echo \"Error: no test specified\" && exit 1"
}
```

## ⚠️ Problemas Identificados e Soluções

### Problema 1: Conexão PostgreSQL com `max: 1`
**Impacto**: Em ambiente serverless, cada invocação pode criar uma nova conexão, esgotando rapidamente o pool.
**Solução**: Aumentado para `max: 10` com timeouts configurados.

### Problema 2: `app.listen()` hardcoded
**Impacto**: Vercel não usa portas fixas em serverless functions.
**Solução**: Condicional que executa `listen()` apenas em desenvolvimento.

### Problema 3: Falta de exportação do app
**Impacto**: Vercel precisa importar o app Express.
**Solução**: Adicionado `module.exports = app;`

### Problema 4: Nodemailer global
**Status**: ⚠️ MONITORAR
**Nota**: O transporter é criado globalmente. Isso funciona, mas pode causar problemas em cold starts. Se houver issues, refatorar para criar sob demanda.

## 🚀 Próximos Passos

1. **Commit das alterações**
```bash
git add .
git commit -m "feat: configurar backend para deploy na Vercel"
git push origin main
```

2. **Deploy na Vercel**
   - Via GitHub (recomendado): Importar repositório em vercel.com
   - Via CLI: `vercel --prod`

3. **Configurar variáveis de ambiente** no dashboard da Vercel:
   - `DATABASE_URL`
   - `EMAIL_USER`
   - `EMAIL_PASS`
   - `NODE_ENV=production`

4. **Testar endpoints** após deploy

## 📊 Compatibilidade

| Funcionalidade | Status | Observações |
|----------------|--------|-------------|
| APIs REST | ✅ | Totalmente compatível |
| PostgreSQL | ✅ | Otimizado para serverless |
| Email (Nodemailer) | ✅ | Funciona, mas considere SendGrid/Resend |
| Dados Mock | ✅ | Função `generateMockCaloriesData()` funciona |
| WebSocket | ❌ | Não suportado pela Vercel |
| Upload de arquivos | ⚠️ | Use S3/Vercel Blob |
| Sessões | ✅ | Baseado em token, funciona |

## 🔍 Monitoramento Recomendado

Após o deploy, monitore:
- ✅ Tempo de resposta das APIs (deve ser < 1s)
- ✅ Número de conexões ao banco
- ✅ Taxa de cold starts
- ✅ Logs de erro

## 📚 Documentação de Referência

- [Vercel Express](https://vercel.com/docs/frameworks/backend/express)
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations)
- [PostgreSQL Best Practices](https://vercel.com/docs/storage/vercel-postgres/limits-and-pricing)

---

**Data**: 2025-01-15
**Versão**: 1.0.0
**Status**: ✅ Pronto para deploy

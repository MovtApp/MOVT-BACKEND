# 📊 Sistema de Gráficos Dinâmicos - MOVT APP

## 📋 Índice

1. [Visão Geral](#visão-geral)
2. [Configuração do Banco de Dados](#configuração-do-banco-de-dados)
3. [APIs Disponíveis](#apis-disponíveis)
4. [Integração Frontend](#integração-frontend)
5. [Timeframes Suportados](#timeframes-suportados)
6. [Testando o Sistema](#testando-o-sistema)

---

## 🎯 Visão Geral

O sistema de gráficos dinâmicos permite visualizar dados de saúde dos usuários de forma interativa e responsiva. Os gráficos se adaptam automaticamente aos dados, calculando domínios dinâmicos (min/max) e oferecendo diferentes períodos de visualização.

### ✨ Funcionalidades

- ✅ Gráficos dinâmicos que se adaptam aos dados
- ✅ Suporte a múltiplos timeframes (1d, 1s, 1m, 1a, Tudo)
- ✅ Paginação automática para grandes volumes de dados
- ✅ Pull-to-refresh para atualizar dados
- ✅ Loading states e tratamento de erros
- ✅ Fallback para dados mockados quando não há dados reais
- ✅ Animações suaves entre transições

---

## 🗄️ Configuração do Banco de Dados

### 1. Executar o Schema SQL

Execute o arquivo `database-schema.sql` no seu banco de dados PostgreSQL:

```bash
psql -U seu_usuario -d nome_do_banco -f database-schema.sql
```

Ou conecte-se ao Supabase SQL Editor e execute o conteúdo do arquivo.

### 2. Verificar Tabelas Criadas

```sql
-- Verificar se a tabela dados_saude foi criada
SELECT * FROM dados_saude LIMIT 1;

-- Verificar índices
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'dados_saude';
```

### 3. Inserir Dados de Teste (Opcional)

```sql
-- Inserir dados de teste para os últimos 7 dias
INSERT INTO dados_saude (id_us, calories, steps, heart_rate, water_intake_ml, timestamp)
SELECT
  1, -- Substitua pelo ID do seu usuário de teste
  FLOOR(1400 + RANDOM() * 600)::INTEGER,
  FLOOR(5000 + RANDOM() * 10000)::INTEGER,
  FLOOR(60 + RANDOM() * 40)::INTEGER,
  FLOOR(1500 + RANDOM() * 2000)::INTEGER,
  CURRENT_TIMESTAMP - (n || ' days')::INTERVAL
FROM generate_series(0, 6) as n;
```

---

## 🚀 APIs Disponíveis

### GET `/api/dados/calories`

Busca dados de calorias do usuário.

#### Headers

```
Authorization: Bearer {sessionId}
```

#### Query Parameters

- `timeframe` (opcional): `1d`, `1s`, `1m`, `1a`, `Tudo` (padrão: `1d`)

#### Resposta de Sucesso (200)

```json
{
  "totalCalories": 1844,
  "remainingCalories": 156,
  "dailyGoal": 2000,
  "data": [
    {
      "date": "2025-01-15T00:00:00.000Z",
      "calories": 1700,
      "timestamp": "2025-01-15T00:00:00.000Z"
    },
    {
      "date": "2025-01-15T01:00:00.000Z",
      "calories": 1844,
      "timestamp": "2025-01-15T01:00:00.000Z"
    }
  ]
}
```

#### Exemplo de Uso

```bash
# Via cURL
curl -X GET \
  'http://localhost:3000/api/dados/calories?timeframe=1s' \
  -H 'Authorization: Bearer seu-session-id-aqui'
```

```javascript
// Via Axios (Frontend)
import { api } from "./services/api";

const response = await api.get("/dados/calories", {
  headers: {
    Authorization: `Bearer ${sessionId}`,
  },
  params: {
    timeframe: "1s",
  },
});

console.log(response.data);
```

---

### POST `/api/dados/calories`

Salva novos dados de calorias.

#### Headers

```
Authorization: Bearer {sessionId}
Content-Type: application/json
```

#### Body

```json
{
  "calories": 1844,
  "timestamp": "2025-01-15T12:00:00.000Z" // opcional
}
```

#### Resposta de Sucesso (201)

```json
{
  "message": "Dados de calorias salvos com sucesso!",
  "data": {
    "id_dado": 123,
    "id_us": 1,
    "calories": 1844,
    "timestamp": "2025-01-15T12:00:00.000Z",
    "created_at": "2025-01-15T12:00:00.000Z",
    "updated_at": "2025-01-15T12:00:00.000Z"
  }
}
```

#### Exemplo de Uso

```bash
# Via cURL
curl -X POST \
  'http://localhost:3000/api/dados/calories' \
  -H 'Authorization: Bearer seu-session-id-aqui' \
  -H 'Content-Type: application/json' \
  -d '{"calories": 1844}'
```

```javascript
// Via Axios (Frontend)
import { api } from "./services/api";

const response = await api.post(
  "/dados/calories",
  {
    calories: 1844,
    timestamp: new Date().toISOString(),
  },
  {
    headers: {
      Authorization: `Bearer ${sessionId}`,
    },
  },
);

console.log(response.data);
```

---

## 💻 Integração Frontend

### Serviço de Calorias

O serviço `caloriesService.ts` já está implementado e oferece:

```typescript
import { getCaloriesData, saveCaloriesData } from "@services/caloriesService";

// Buscar dados
const stats = await getCaloriesData("1s"); // '1d', '1s', '1m', '1a', 'Tudo'

// Salvar dados
await saveCaloriesData(1844);
```

### Componente CaloriesScreen

O componente já está totalmente implementado com:

- ✅ Integração com API
- ✅ Loading states
- ✅ Pull-to-refresh
- ✅ Paginação de gráficos
- ✅ Seleção de timeframe
- ✅ Gráfico dinâmico com Victory Native

---

## ⏱️ Timeframes Suportados

| Timeframe | Descrição       | Pontos de Dados      | Agrupamento |
| --------- | --------------- | -------------------- | ----------- |
| `1d`      | Um dia          | 24 (por hora)        | Hora        |
| `1s`      | Uma semana      | 7                    | Dia         |
| `1m`      | Um mês          | 30                   | Dia         |
| `1a`      | Um ano          | 12                   | Mês         |
| `Tudo`    | Todos os tempos | 60 (últimos 60 dias) | Mês         |

---

## 🧪 Testando o Sistema

### 1. Iniciar o Backend

```bash
cd MOVT-BACKEND
npm run dev
```

### 2. Iniciar o Frontend

```bash
cd MOVT
npx expo start --clear
```

### 3. Fazer Login no App

Use suas credenciais para fazer login e obter o `sessionId`.

### 4. Testar via Postman/Insomnia

#### Buscar Dados

```
GET http://localhost:3000/api/dados/calories?timeframe=1s
Headers:
  Authorization: Bearer SEU_SESSION_ID
```

#### Salvar Dados

```
POST http://localhost:3000/api/dados/calories
Headers:
  Authorization: Bearer SEU_SESSION_ID
  Content-Type: application/json
Body:
  {
    "calories": 1844
  }
```

### 5. Verificar Logs

O backend exibe logs detalhados de todas as operações:

```
=== INÍCIO DA ROTA GET /api/dados/calories ===
Timestamp: 2025-01-15T12:00:00.000Z
User ID: 1
Buscando dados de calorias de ...
✅ Encontrados 7 registros de calorias
--- RESPOSTA DE SUCESSO ---
Total de calorias: 1844
=== FIM DA ROTA GET /api/dados/calories (SUCESSO) ===
```

---

## 🐛 Troubleshooting

### Problema: "Token de sessão inválido"

**Solução**: Verifique se você está enviando o header `Authorization: Bearer {sessionId}` corretamente.

### Problema: "Nenhum dado disponível"

**Solução**: O sistema usa dados mockados automaticamente quando não há dados reais. Insira alguns dados de teste no banco.

### Problema: "Erro ao conectar com o backend"

**Solução**:

1. Verifique se o backend está rodando na porta 3000
2. Confirme o IP correto no arquivo `src/config/api.ts`
3. Para Android: use o IP da rede local (ex: `192.168.15.45:3000`)
4. Para iOS: use `localhost:3000`

### Problema: Gráfico não aparece

**Solução**:

1. Verifique os logs do Metro bundler
2. Certifique-se que `victory-native` está instalado
3. Limpe o cache: `npx expo start --clear`

---

## 📈 Próximos Passos

1. Integrar com Google Fit / Apple Health
2. Adicionar mais tipos de dados (passos, sono, água)
3. Implementar notificações push para metas
4. Criar dashboard com múltiplos gráficos
5. Adicionar exportação de dados (PDF/CSV)
6. Implementar compartilhamento social de conquistas

---

## 📝 Notas Importantes

- ⚠️ **Segurança**: Sempre use HTTPS em produção
- ⚠️ **Performance**: Os índices no banco de dados são essenciais para performance
- ⚠️ **Backup**: Faça backup regular dos dados de saúde dos usuários
- ⚠️ **LGPD/GDPR**: Implemente políticas de privacidade e consentimento do usuário

---

## 🤝 Contribuindo

Para adicionar novos tipos de gráficos:

1. Adicione a coluna correspondente na tabela `dados_saude`
2. Crie um novo serviço em `services/` (ex: `stepsService.ts`)
3. Crie uma nova rota no backend (ex: `/api/dados/steps`)
4. Copie e adapte o `CaloriesScreen.tsx` para o novo dado
5. Atualize esta documentação

---

## 📞 Suporte

Para dúvidas ou problemas:

- 📧 Email: suporte@movtapp.com
- 💬 Discord: MOVT Community
- 🐛 Issues: GitHub Repository

---

**Desenvolvido com ❤️ pela equipe MOVT**

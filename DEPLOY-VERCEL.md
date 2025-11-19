# 🚀 Deploy do MOVT Backend na Vercel

## 📋 Ajustes Realizados

### ✅ Problemas Corrigidos

1. **Conexão PostgreSQL otimizada para Serverless**
   - Aumentado `max` de 1 para 10 conexões
   - Adicionado `idle_timeout: 20s` e `connect_timeout: 10s`
   - Previne esgotamento do pool de conexões

2. **App.listen() condicional**
   - Executa apenas em desenvolvimento local
   - Em produção (Vercel), exporta o app via `module.exports`

3. **Configuração Vercel completa**
   - Arquivo `vercel.json` criado
   - Arquivo `.vercelignore` para otimizar deploy

## 🔧 Pré-requisitos

1. Conta na Vercel ([vercel.com](https://vercel.com))
2. Vercel CLI instalado (opcional)
```bash
npm i -g vercel
```

## 📦 Configuração de Variáveis de Ambiente

No dashboard da Vercel, adicione as seguintes variáveis:

### Obrigatórias:

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | URL do PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `EMAIL_USER` | Email para envio | `seuemail@gmail.com` |
| `EMAIL_PASS` | Senha do email | `suasenha` |
| `SUPABASE_URL` | URL do projeto Supabase | `https://[projeto-id].supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key do Supabase | `eyJhbGci...` (key longa) |
| `SUPABASE_AVATAR_BUCKET` | Nome do bucket de avatares | `avatars` |
| `NODE_ENV` | Ambiente | `production` |

### 📸 Como obter as credenciais do Supabase Storage:

1. **Acesse o Dashboard**: https://supabase.com/dashboard
2. **Selecione seu projeto**
3. **Settings → API**:
   - Copie a **Project URL** → use como `SUPABASE_URL`
   - Copie a **service_role** key (não a anon key) → use como `SUPABASE_SERVICE_ROLE_KEY`
4. **Storage → New Bucket**:
   - Nome: `avatars`
   - Marque como **Public**
   - Crie o bucket

### Como adicionar:
1. Acesse: https://vercel.com/[seu-time]/[seu-projeto]/settings/environment-variables
2. Adicione cada variável
3. Selecione os ambientes: **Production**, **Preview** e **Development**

## 🚀 Deploy via GitHub (Recomendado)

### 1. Conectar Repositório
```bash
# Commit e push das alterações
git add .
git commit -m "feat: configurar para deploy na Vercel"
git push origin main
```

### 2. Importar Projeto na Vercel
1. Acesse: https://vercel.com/new
2. Selecione seu repositório GitHub
3. Configure:
   - **Framework Preset**: Other
   - **Root Directory**: `./`
   - **Build Command**: (deixe vazio)
   - **Output Directory**: (deixe vazio)
4. Adicione as variáveis de ambiente
5. Clique em **Deploy**

## 🖥️ Deploy via Vercel CLI

```bash
# Login na Vercel
vercel login

# Deploy para preview
vercel

# Deploy para produção
vercel --prod
```

## ⚠️ Limitações Importantes da Vercel

### 1. **Tempo de Execução**
- Máximo: **10 segundos** (Hobby)
- Máximo: **60 segundos** (Pro)
- **Ação**: Se suas rotas demoram mais, considere otimizações

### 2. **Tamanho da Função**
- Máximo: **250 MB** (descompactado)
- **Ação**: Já configurado `.vercelignore` para excluir arquivos desnecessários

### 3. **Conexões WebSocket**
- **Não suportado** em Vercel Functions
- **Ação**: Use serviços externos como Pusher ou Ably para realtime

### 4. **Dados Mockados**
- A função `generateMockCaloriesData()` funciona normalmente
- **Ação**: Nenhuma alteração necessária

### 5. **Upload de Arquivos**
- **Não recomendado** fazer upload direto para serverless
- **Ação**: Use Vercel Blob, AWS S3 ou outro storage externo

### 6. **Envio de Emails**
- Nodemailer funciona, mas pode ser lento
- **Ação**: Considere serviços como SendGrid, Resend ou Postmark

## 🧪 Testar Localmente

```bash
# Instalar Vercel CLI
npm i -g vercel

# Executar localmente com ambiente Vercel
vercel dev

# Ou usar o script normal
npm run dev
```

## 🔍 Verificar Deploy

Após o deploy:

```bash
# Testar endpoint
curl https://seu-projeto.vercel.app/login

# Verificar logs
vercel logs
```

## 📊 Monitoramento

1. **Logs em Tempo Real**: https://vercel.com/[time]/[projeto]/deployments
2. **Métricas**: https://vercel.com/[time]/[projeto]/analytics
3. **Funções**: https://vercel.com/[time]/[projeto]/functions

## 🐛 Troubleshooting

### Erro: "Function Timeout"
**Solução**: Otimize queries ou upgrade para plano Pro

### Erro: "Database connection failed"
**Solução**: 
- Verifique se `DATABASE_URL` está configurada corretamente
- Certifique-se que o Postgres aceita conexões externas
- Supabase/Neon funcionam perfeitamente com Vercel

### Erro: "Too many connections"
**Solução**: Use connection pooling (já configurado) ou Supabase Pooler

### Email não envia
**Solução**:
- Verifique `EMAIL_USER` e `EMAIL_PASS`
- Gmail: habilite "Acesso a apps menos seguros" ou use App Password
- Considere usar serviços como SendGrid

## 📈 Otimizações Recomendadas

### 1. **Connection Pooling**
Para melhor performance, considere usar PgBouncer ou Supabase Pooler:
```javascript
const sql = postgres(process.env.POOLED_DATABASE_URL, {
  ssl: "require",
  max: 1, // Com pooler, 1 é suficiente
  prepare: false,
});
```

### 2. **Caching**
Use Vercel Edge Config ou Redis para cache:
```bash
npm install @vercel/edge-config
```

### 3. **Rate Limiting**
Adicione rate limiting para proteger suas APIs:
```bash
npm install express-rate-limit
```

## 🔐 Segurança

- ✅ Nunca commite o arquivo `.env`
- ✅ Use variáveis de ambiente da Vercel
- ✅ Configure CORS adequadamente
- ✅ Adicione rate limiting em produção
- ✅ Valide todos os inputs

## 📚 Recursos Úteis

- [Vercel Express Docs](https://vercel.com/docs/frameworks/backend/express)
- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel Limits](https://vercel.com/docs/limits)
- [PostgreSQL on Vercel](https://vercel.com/docs/storage/vercel-postgres)

## 🆘 Suporte

- [Vercel Community](https://github.com/vercel/vercel/discussions)
- [Vercel Support](https://vercel.com/support)

---

**✨ Deploy configurado com sucesso! Pronto para produção.**

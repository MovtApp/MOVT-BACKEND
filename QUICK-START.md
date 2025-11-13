# ⚡ Quick Start - Deploy na Vercel

## 🎯 3 Passos para Deploy

### 1️⃣ Verificar Configuração
```bash
npm run verify
```
✅ Deve mostrar "TUDO CERTO! Pronto para deploy na Vercel! 🚀"

### 2️⃣ Commit e Push
```bash
git add .
git commit -m "feat: configurar backend para deploy na Vercel"
git push origin main
```

### 3️⃣ Deploy na Vercel

**Opção A - Via Website (Recomendado)**
1. Acesse: https://vercel.com/new
2. Importe o repositório `MOVT-BACKEND`
3. **NÃO altere** as configurações de build
4. Adicione as variáveis de ambiente:
   ```
   DATABASE_URL=sua_url_postgresql
   EMAIL_USER=seu_email@gmail.com
   EMAIL_PASS=sua_senha_app
   NODE_ENV=production
   ```
5. Clique em **Deploy**
6. Aguarde ~2 minutos ⏱️
7. Pronto! 🎉

**Opção B - Via CLI**
```bash
# Instalar CLI (apenas primeira vez)
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

## 🔐 Configurar Variáveis de Ambiente na Vercel

1. Acesse o projeto na Vercel
2. Vá em **Settings** → **Environment Variables**
3. Adicione:

| Name | Value | Environments |
|------|-------|--------------|
| `DATABASE_URL` | `postgresql://...` | Production, Preview, Development |
| `EMAIL_USER` | `seu@email.com` | Production, Preview, Development |
| `EMAIL_PASS` | `senha_app` | Production, Preview, Development |
| `NODE_ENV` | `production` | Production |

4. Salvar

## ✅ Testar Deploy

```bash
# Substituir pela sua URL da Vercel
curl https://seu-projeto.vercel.app/

# Testar login
curl -X POST https://seu-projeto.vercel.app/login \
  -H "Content-Type: application/json" \
  -d '{"email":"teste@email.com","senha":"senha123"}'
```

## 🎊 Pronto!

Seu backend está rodando na Vercel! 

**URL do Projeto**: `https://seu-projeto.vercel.app`

## 📚 Próximos Passos

- [ ] Configurar domínio customizado
- [ ] Configurar CORS para seu frontend
- [ ] Adicionar monitoring (Vercel Analytics)
- [ ] Configurar Vercel Postgres (opcional)

## 🆘 Precisa de Ajuda?

📖 Veja a [documentação completa](DEPLOY-VERCEL.md)

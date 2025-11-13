# 🏃 MOVT Backend API

Backend do aplicativo MOVT - Sistema de gerenciamento de saúde, dietas e dispositivos wearable.

## 🚀 Deploy

Este projeto está **configurado e pronto** para deploy na **Vercel**.

### Deploy Rápido
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone)

📖 **[Guia Completo de Deploy →](DEPLOY-VERCEL.md)**

## 📋 Índice

- [Tecnologias](#tecnologias)
- [Instalação](#instalação)
- [Variáveis de Ambiente](#variáveis-de-ambiente)
- [Scripts Disponíveis](#scripts-disponíveis)
- [Estrutura de APIs](#estrutura-de-apis)
- [Deploy](#deploy)

## 🛠️ Tecnologias

- **Node.js** (v18+)
- **Express.js** (v5.1.0)
- **PostgreSQL** (via postgres.js)
- **Bcrypt** - Criptografia de senhas
- **JWT** - Autenticação via tokens
- **Nodemailer** - Envio de emails
- **UUID** - Geração de IDs únicos

## 📦 Instalação

### Desenvolvimento Local

```bash
# Clone o repositório
git clone https://github.com/Jvlima22/MOVT-BACKEND.git
cd MOVT-BACKEND

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais

# Inicie o servidor de desenvolvimento
npm run dev
```

O servidor estará rodando em `http://localhost:3000`

## 🔐 Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/database

# Email
EMAIL_USER=seu-email@gmail.com
EMAIL_PASS=sua-senha-app

# Environment
NODE_ENV=development
```

## 📜 Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia servidor com nodemon (hot reload) |
| `npm start` | Inicia servidor em produção |
| `npm run verify` | Verifica configuração para deploy |

## 🔌 Estrutura de APIs

### 🔐 Autenticação

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/login` | Login de usuário |
| POST | `/register` | Registro de novo usuário |

### 👤 Usuário

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| GET | `/user/session-status` | Status da sessão | ✅ |
| POST | `/user/send-verification` | Envia código de verificação | ✅ |
| POST | `/user/verify` | Verifica email | ✅ |

### 🥗 Dietas

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| POST | `/api/dietas` | Criar nova dieta | ✅ |
| GET | `/api/dietas` | Listar dietas do usuário | ✅ |
| GET | `/api/dietas/:id` | Buscar dieta por ID | ✅ |
| PUT | `/api/dietas/:id` | Atualizar dieta | ✅ |
| DELETE | `/api/dietas/:id` | Deletar dieta | ✅ |

### 📊 Dados de Saúde

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| GET | `/api/dados/calories` | Dados de calorias | ✅ |
| POST | `/api/dados/calories` | Salvar calorias | ✅ |

### ⌚ Wear OS

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| POST | `/api/wearos/register-device` | Registrar dispositivo | ✅ |
| GET | `/api/wearos/devices` | Listar dispositivos | ✅ |
| GET | `/api/wearos/devicesON` | Verificar dispositivos ativos | ✅ |
| POST | `/api/wearos/health` | Enviar dados de saúde | ✅ |
| GET | `/api/wearos/health` | Obter dados de saúde | ✅ |
| GET | `/api/wearos/health-history` | Histórico de saúde | ✅ |
| PUT | `/api/wearos/status/:deviceId` | Atualizar status | ✅ |
| DELETE | `/api/wearos/device/:deviceId` | Remover dispositivo | ✅ |

## 🔒 Autenticação

Todas as rotas protegidas requerem header de autorização:

```http
Authorization: Bearer {sessionId}
```

## 📊 Timeframes Suportados

Para gráficos e histórico de dados:

| Código | Descrição | Período |
|--------|-----------|---------|
| `1d` | Um dia | Últimas 24 horas |
| `1s` | Uma semana | Últimos 7 dias |
| `1m` | Um mês | Últimos 30 dias |
| `1a` | Um ano | Últimos 12 meses |
| `Tudo` | Todos | Últimos 60 dias |

## 🚀 Deploy na Vercel

### Verificação Pré-Deploy

```bash
npm run verify
```

### Deploy via CLI

```bash
# Instalar Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

### Deploy via GitHub

1. Push para GitHub
2. Importe o repositório em [vercel.com/new](https://vercel.com/new)
3. Configure as variáveis de ambiente
4. Deploy! 🎉

**📖 [Guia Completo de Deploy](DEPLOY-VERCEL.md)**

## 📝 Documentação Adicional

- **[Deploy na Vercel](DEPLOY-VERCEL.md)** - Guia completo de deploy
- **[Changelog Vercel](CHANGELOG-VERCEL.md)** - Alterações para Vercel
- **[Gráficos](README-GRAFICOS.md)** - Sistema de gráficos dinâmicos
- **[Schema SQL](database-schema.sql)** - Estrutura do banco de dados

## ⚠️ Limitações da Vercel

| Limitação | Valor | Observação |
|-----------|-------|------------|
| Tempo de execução | 10s (Hobby) / 60s (Pro) | Otimize queries |
| Tamanho da função | 250 MB | Já otimizado |
| Região padrão | Washington DC | Configurável |
| WebSocket | ❌ Não suportado | Use serviços externos |

## 🐛 Troubleshooting

### Erro de conexão com banco
```bash
# Verifique se DATABASE_URL está correta
echo $DATABASE_URL

# Teste a conexão
psql $DATABASE_URL
```

### Erro ao enviar email
- Gmail: Use senha de app (não a senha normal)
- Habilite "Acesso a apps menos seguros"
- Ou use serviços como SendGrid/Resend

### Timeout nas requisições
- Otimize queries SQL
- Use índices no banco
- Considere cache com Redis
- Upgrade para plano Pro (60s timeout)

## 📞 Suporte

- 📧 Email: suporte@movtapp.com
- 🐛 Issues: [GitHub Issues](https://github.com/Jvlima22/MOVT-BACKEND/issues)

## 📄 Licença

ISC

---

**Desenvolvido com ❤️ pela equipe MOVT**

[![Powered by Vercel](https://www.datocms-assets.com/31049/1618983297-powered-by-vercel.svg)](https://vercel.com)

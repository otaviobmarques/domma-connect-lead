# Domma Connect Lead

SaaS da Domma Tecnologia para disparar mensagens de WhatsApp a partir de planilhas (Excel/CSV), com personalização por IA.

## O que já funciona

- **Contas por empresa:** cadastro, login e dados separados para cada empresa
- **Conexões:** API Oficial da Meta (Cloud API), QR Code (WhatsApp Web via Baileys) e uma conexão de teste que simula os envios
- **Planilhas:** lê .xlsx, .xls e .csv, acha sozinha as colunas de telefone e nome, normaliza números do Brasil (DDD, 9º dígito, +55), remove repetidos, marca inválidos e permite exportar as linhas com problema
- **Assistente em 4 passos:** contatos, mensagem, envio e revisão, com prévia num celular
  - Variáveis `{{primeiro_nome}}`, `{{cidade}}`, `{{coluna|valor padrão}}` e `{{saudacao}}` (bom dia, boa tarde ou boa noite)
  - Spintax `{Oi|Olá|E aí}` para variar o texto entre contatos
  - Anexos: imagem, vídeo, PDF ou áudio, enviados do computador ou escolhidos na galeria
  - Modelos prontos para o setor automotivo e para negócios em geral
  - Templates aprovados na API Oficial, com cada variável ligada a uma coluna da planilha
  - **✨ IA que personaliza cada mensagem** usando os dados do contato e o playbook de vendas. Se a IA falhar, vai a mensagem base.
- **App para PC (Windows):** motor de envio que mantém o WhatsApp por QR Code e dispara as campanhas; download na área logada (**App para PC**)
- **Fila de envio:** velocidades Segura, Normal e Rápida, ou intervalo **personalizado** (mínimo, máximo e pausa a cada N mensagens); horário e dias permitidos; limite diário por número; "digitando…" simulado; agendamento; pausar, retomar e cancelar; nova tentativa para falhas
- **Descadastro:** quem responde SAIR, PARAR ou algo parecido nunca mais recebe
- **Relatórios:** enviadas, entregues, lidas, respostas e erros, com exportação para Excel
- **Administrador:** perfil da empresa com logo, playbook de vendas, IAs (Claude, ChatGPT e Gemini, com principal e reserva), tempo de disparo, digitação, galeria e webhook

## Como está no ar

| Parte | Onde |
|---|---|
| Site e painel (`public/`) + API (`api/index.js` → `server/app.js`) | **Vercel**, projeto `domma-connect-lead` (região São Paulo) |
| Banco de dados e arquivos (mídias, logos, planilhas) | **Supabase**, projeto `domma-connect-lead`, schema `connect_lead`, usuário `connect_lead_app` |
| Motor de envio do QR Code | **App para Windows** (`desktop/`), instalado no PC do cliente |

A Vercel só roda funções curtas, então não dá para manter o WhatsApp Web conectado nem uma fila rodando sem parar lá. Por isso:

- A fila anda em **ciclos** (`server/dispatch.js`). Cada ciclo é pedido pelo app do PC (a cada 2 s) ou pelo painel aberto no navegador (a cada 4 s).
- **API Oficial e conexão de teste:** o próprio servidor envia dentro do ciclo. Funciona com o painel ou o app aberto.
- **QR Code:** o servidor monta a mensagem (variáveis, IA, descadastro, horário, limite) e entrega ao app do PC, que envia pelo Baileys e devolve o resultado. O número fica ligado ao computador onde o QR foi lido.
- Arquivos ficam no banco em pedaços de 3 MB, porque a Vercel limita cada requisição a 4,5 MB.

## Rodar localmente

```bash
npm install
DATABASE_URL=postgresql://usuario:senha@localhost:5432/banco npm start   # http://localhost:3000 (cria as tabelas)
```

Para testar o QR Code localmente, rode também o motor de envio:

```bash
ENGINE_URL=http://localhost:3000 ENGINE_EMAIL=voce@empresa.com ENGINE_PASSWORD=suasenha npm run engine
```

## Variáveis de ambiente (Vercel)

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Conexão do Postgres. No Supabase, use o pooler de transações (porta 6543) com o usuário `connect_lead_app.<ref-do-projeto>` |
| `NODE_ENV=production` | Cookies seguros (HTTPS) |
| `APP_URL` | URL pública, usada para montar a URL do webhook (opcional) |
| `JWT_SECRET` / `ENCRYPTION_KEY` | Opcionais. Se faltarem, são gerados na primeira execução e guardados na tabela `app_secrets` |
| `META_VERIFY_TOKEN` / `META_APP_SECRET` | Webhook da API Oficial (o segredo valida a assinatura; recomendado) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Chaves de IA padrão para todas as empresas (opcional) |
| `DESKTOP_DOWNLOAD_URL` / `DESKTOP_VERSION` | Link e versão do instalador mostrados em **App para PC** |

Mudou o schema? Atualize `server/schema.sql` (sempre idempotente) e rode `npm run db:migrate` com o `DATABASE_URL` de produção.

## App para Windows

O código fica em `desktop/` (Electron). Ele abre o painel da Vercel numa janela e roda `engine/engine.js` em segundo plano, com ícone na bandeja perto do relógio.

- Gerar o instalador: GitHub → **Actions → App para Windows → Run workflow**, ou crie a tag `desktop-vX.Y.Z`. O `.exe` vai para **Releases**, e o painel aponta para `releases/latest/download/DommaConnectLead-Setup.exe`.
- O instalador não é assinado digitalmente, então o Windows pode mostrar o aviso do SmartScreen ("Mais informações → Executar assim mesmo").
- Endereço do painel usado pelo app: `desktop/config.json`.

## Estrutura

```
api/index.js        entrada da Vercel
server/
  app.js            rotas da API, webhook da Meta e /api/engine/* (app do PC)
  index.js          servidor local (npm start)
  db.js             Postgres (pg); use ? nos SQLs
  schema.sql        tabelas (idempotente)
  dispatch.js       fila em ciclos: velocidade, pausas, horário, limite diário, IA, descadastro
  files.js          arquivos em pedaços no banco
  secrets.js        segredos de sessão e criptografia
  ai.js             IA (Claude/OpenAI/Gemini, com reserva)
  settings.js       configurações do administrador + contexto do negócio para a IA
  spreadsheet.js    leitura de planilha e detecção de colunas
  phone.js          normalização de telefones
  render.js         variáveis e spintax
  connections.js    conexões sem estado e webhook da Meta
  drivers/          oficial.js, simulado.js (rodam no servidor)
engine/             motor de envio: engine.js (ciclos e envios) e qr-driver.js (Baileys)
desktop/            app Electron para Windows
public/             painel (HTML, CSS e JS, sem etapa de build)
```

## Próximos passos sugeridos

- Teste real com QR Code pelo app do PC e com a API Oficial (webhook apontando para a Vercel)
- Domínio próprio (ex.: connect.domma.com.br) e assinatura digital do instalador
- Planos e cobrança (Asaas, Mercado Pago, Stripe) e limites por plano
- Vários usuários por empresa (vendedores) com permissões
- Integração com o Domma CRM e o Domma Chat por API ou webhook

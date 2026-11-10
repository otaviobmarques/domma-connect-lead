# Domma Connect Lead — guia para o Claude Code

SaaS da **Domma Tecnologia** (marca da Scale360) para disparar WhatsApp a partir de planilhas Excel/CSV, com personalização por IA. Concorrente direto da PlugLead (pluglead.com). O objetivo é ser **mais fácil de usar** do que ela.

## Como rodar
```bash
npm install
DATABASE_URL=postgresql://... npm start   # http://localhost:3000 (demais variáveis no README)
npm run engine                            # motor de envio (QR Code), o mesmo do app do PC
```
Para testar sem WhatsApp real, crie uma conta e adicione uma "Conexão de teste" em Conexões.

## Stack e decisões (mantenha)
- Node 20+, **ESM** (`"type": "module"`), Express 5, **Postgres no Supabase** (`pg`, schema `connect_lead`), Baileys para o QR Code e fetch nativo para a Meta e as IAs.
- **Hospedagem:** site + API na **Vercel** (`api/index.js`, funções curtas, sem estado em memória). Banco e arquivos no **Supabase**. O QR Code roda no **app para Windows** (`desktop/`, Electron), que usa `engine/`.
- O front-end está em `public/` e é **JS puro, sem build** (app.js, app.css e index.html), com rotas por hash (`#/...`). Não troque por React sem o usuário pedir.
- A fila (`server/dispatch.js`) anda em **ciclos** (`tick`): pedidos pelo app do PC a cada 2 s (`/api/engine/tick`) e pelo painel aberto a cada 4 s (`/api/queue/tick`). Cada campanha é reservada com `next_send_at` antes de enviar, para não haver envio duplo. API Oficial e teste enviam no servidor; QR Code vira um "job" que o app do PC executa e devolve em `/api/engine/result`.
- Arquivos (mídias, logos, planilhas) ficam no banco em pedaços de 3 MB (`server/files.js`), por causa do limite de 4,5 MB por requisição da Vercel. O front-end usa `uploadFile()`.
- Tudo é separado por `workspace_id`, e cada empresa é uma conta.
- As configurações do administrador ficam em `workspaces.settings_json` (`server/settings.js`). Seções: perfil, playbook, ia, disparo, digitacao e galeria.
- As chaves de IA são salvas criptografadas (AES-GCM, `server/ai.js`) e nunca são devolvidas ao front-end.
- Drivers de envio: `server/drivers/oficial.js` (Meta Cloud API) e `simulado.js` rodam no servidor; `engine/qr-driver.js` (Baileys) roda no app do PC. Todos expõem `start/stop/logout/send` + hooks `onState/onStatus/onIncoming`.

## Identidade visual
- Marca Domma Tecnologia. Os arquivos ficam em `public/brand/` (símbolo e a palavra "Domma" em versões branca e escura, mais o favicon). O produto aparece como **"Domma" + "CONNECT LEAD"** em caixa alta e espaçado.
- Cores: roxo `#6B59FE` (principal), azul-marinho `#1E1136` (menu e login), fonte Inter.
- Todo o texto da interface é em **português do Brasil**, simples e direto. O público não é técnico.

## Regras de produto
- Nunca remova o descadastro (SAIR/PARAR) nem a checagem de descadastrados antes de cada envio.
- A IA não pode inventar preço, desconto, prazo ou link. O prompt fica em `server/ai.js` e o contexto do negócio em `businessContext()`.
- Se a IA falhar, envie a mensagem base e registre o motivo em `messages.error`.
- Na API Oficial, campanhas para listas frias usam **templates aprovados**. Texto livre só chega dentro da janela de 24h.
- Velocidade, pausas, horário permitido, limite diário e "digitando…" vêm do Administrador e podem ser ajustados em cada campanha.

## Mapa do código
```
api/index.js           entrada da Vercel
server/app.js          rotas /api/*, webhook /webhook/meta e /api/engine/* (app do PC)
server/db.js           Postgres (use ? nos SQLs); schema em server/schema.sql
server/dispatch.js     fila em ciclos: velocidade, pausas, horário, limite diário, IA, opt-out
server/files.js        arquivos em pedaços no banco
server/ai.js           Claude / OpenAI / Gemini com IA de reserva
server/settings.js     padrões do administrador e contexto para a IA
server/spreadsheet.js  leitura de planilha e detecção de colunas
server/phone.js        normalização de telefones do Brasil
server/render.js       {{variaveis}}, {{var|padrão}}, {{saudacao}} e spintax {a|b}
server/connections.js  conexões sem estado, hooks e webhook da Meta
engine/                motor de envio (engine.js + qr-driver.js)
desktop/               app Electron para Windows (instalador gerado pelo GitHub Actions)
public/app.js          todas as telas (login, início, assistente, campanhas, listas, conexões, descadastrados, app para PC, administrador)
```

## Estado atual
No ar na Vercel (`domma-connect-lead`, time REDBOX) com banco no Supabase (`domma-connect-lead`). Testado ponta a ponta em produção com a conexão simulada: importação, anexos em pedaços, campanha, fila em ciclos, descadastro durante a campanha, entregue/lido, relatório e exportação. O motor de envio gerou o QR Code real do WhatsApp e o desconectar funcionou. **Ainda falta** ler o QR com um celular e disparar de verdade, e testar a API Oficial.

## Próximas tarefas (em ordem)
1. **Teste real com QR Code pelo app do PC:** conectar um número, disparar para 3 ou 4 números internos e conferir "digitando…", entregue/lido e resposta SAIR.
2. **Teste real da API Oficial:** webhook da Meta apontando para a URL da Vercel, templates, status e respostas.
3. **Domínio próprio** e assinatura digital do instalador.
4. **Planos e cobrança:** Starter, Pro, Advanced e Enterprise, com limites de números, disparos por mês e IA. Gateways Asaas, Mercado Pago e Stripe, cada um podendo ser ligado ou desligado.
5. **Vários usuários por empresa** (dono e vendedores) com permissões. Hoje todo usuário é `owner`.
6. **Integração com o Domma CRM e o Domma Chat** por API/webhook.

## Cuidados
- Não faça commit de `data/` (sessões do WhatsApp do motor local).
- Antes de mudar o schema, edite `server/schema.sql` de forma idempotente (`ADD COLUMN IF NOT EXISTS`) e rode `npm run db:migrate` em produção. As tabelas pertencem ao usuário `connect_lead_app`.
- Nada de estado em memória no servidor: ele roda em funções da Vercel. O que precisa ficar ligado vai para o motor (`engine/`).
- Depois de mudar as telas, abra o sistema no navegador e confira o resultado. Teste também em 390 px de largura.

# Domma Connect Lead — guia para o Claude Code

SaaS da **Domma Tecnologia** (marca da Scale360) para disparar WhatsApp a partir de planilhas Excel/CSV, com personalização por IA. Concorrente direto da PlugLead (pluglead.com). O objetivo é ser **mais fácil de usar** do que ela.

## Como rodar
```bash
npm install
npm start            # http://localhost:3000  (PORT, DATA_DIR e demais variáveis no README)
```
Para testar sem WhatsApp real, crie uma conta e adicione uma "Conexão de teste" em Conexões.

## Stack e decisões (mantenha)
- Node 20+, **ESM** (`"type": "module"`), Express 5, SQLite (better-sqlite3), Baileys para o QR Code e fetch nativo para a Meta e as IAs.
- O front-end está em `public/` e é **JS puro, sem build** (app.js, app.css e index.html), com rotas por hash (`#/...`). Não troque por React sem o usuário pedir.
- A fila (`server/queue.js`) roda dentro do mesmo processo, verificando a cada 1 s. As sessões do QR Code ficam em memória, então o sistema roda em **um único processo**.
- Tudo é separado por `workspace_id`, e cada empresa é uma conta.
- As configurações do administrador ficam em `workspaces.settings_json` (`server/settings.js`). Seções: perfil, playbook, ia, disparo, digitacao e galeria.
- As chaves de IA são salvas criptografadas (AES-GCM, `server/ai.js`) e nunca são devolvidas ao front-end.
- Drivers de envio ficam em `server/drivers/`: `oficial.js` (Meta Cloud API), `qrcode.js` (Baileys) e `simulado.js`. Todos expõem a mesma interface: `start/stop/logout/send` + hooks `onState/onStatus/onIncoming`.

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
server/index.js        rotas /api/* e webhook /webhook/meta
server/db.js           schema SQLite
server/queue.js        fila: velocidade, pausas, horário, limite diário, IA, opt-out
server/ai.js           Claude / OpenAI / Gemini com IA de reserva
server/settings.js     padrões do administrador e contexto para a IA
server/spreadsheet.js  leitura de planilha e detecção de colunas
server/phone.js        normalização de telefones do Brasil
server/render.js       {{variaveis}}, {{var|padrão}}, {{saudacao}} e spintax {a|b}
server/connections.js  gerenciador de conexões e roteamento de webhooks
public/app.js          todas as telas (login, início, assistente de 4 passos, campanhas, listas, conexões, descadastrados, administrador)
```

## Estado atual
Testado ponta a ponta com a conexão simulada: importação, normalização, campanha, fila, limite diário, horário, falha da IA com envio da mensagem base, relatório e exportação. **Ainda não testado com WhatsApp real** (QR Code e API Oficial), porque o ambiente onde foi criado não tinha acesso ao WhatsApp.

## Próximas tarefas (em ordem)
1. **Deploy no Railway** com volume persistente em `/data` (`DATA_DIR=/data`), `NODE_ENV=production`, `APP_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` e `META_APP_SECRET`. Um único processo.
2. **Teste real com QR Code:** conectar um número, disparar para 3 ou 4 números internos e conferir "digitando…", entregue/lido e resposta SAIR.
3. **Teste real da API Oficial:** cadastrar Phone Number ID, WABA e token, listar templates, disparar e conferir os webhooks de status e de mensagens.
4. **Planos e cobrança:** Starter, Pro, Advanced e Enterprise, com limites de números, disparos por mês e IA. Gateways Asaas, Mercado Pago e Stripe, cada um podendo ser ligado ou desligado.
5. **Vários usuários por empresa** (dono e vendedores) com permissões. Hoje todo usuário é `owner`.
6. **Integração com o Domma CRM e o Domma Chat** por API/webhook: enviar leads que responderam e marcar a temperatura do lead.
7. Para escalar: Postgres no lugar do SQLite e BullMQ/Redis no lugar da fila em memória.

## Cuidados
- Não faça commit de `data/` (banco, sessões do WhatsApp, uploads, chaves).
- Antes de mudar o schema, adicione uma migração idempotente (`ALTER TABLE ... ADD COLUMN` dentro de try/catch, como em `settings.js`).
- Depois de mudar as telas, abra o sistema no navegador e confira o resultado. Teste também em 390 px de largura.

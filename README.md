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
- **Fila de envio:** velocidades Segura, Normal e Rápida, ou intervalo **personalizado** (mínimo, máximo e pausa a cada N mensagens); horário e dias permitidos; limite diário por número; "digitando…" simulado; agendamento; pausar, retomar e cancelar; nova tentativa para falhas
- **Descadastro:** quem responde SAIR, PARAR ou algo parecido nunca mais recebe
- **Relatórios:** enviadas, entregues, lidas, respostas e erros, com exportação para Excel
- **Administrador:** perfil da empresa com logo, playbook de vendas, IAs (Claude, ChatGPT e Gemini, com principal e reserva), tempo de disparo, digitação, galeria e webhook

## Rodar localmente

```bash
npm install
npm start          # http://localhost:3000
```

Crie uma conta e, em **Conexões**, adicione uma "Conexão de teste" para experimentar sem enviar nada de verdade.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `PORT` | Porta HTTP (padrão 3000) |
| `DATA_DIR` | Pasta do banco SQLite, dos uploads e das sessões do QR Code (padrão `./data`). **Em produção, use um volume persistente.** |
| `APP_URL` | URL pública, usada para montar a URL do webhook |
| `JWT_SECRET` | Segredo das sessões (se não for definido, é gerado e salvo em `DATA_DIR`) |
| `ENCRYPTION_KEY` | Chave para criptografar as chaves de IA (se não for definida, é gerada e salva em `DATA_DIR`) |
| `META_VERIFY_TOKEN` | Token de verificação global do webhook (opcional; cada empresa também tem o seu) |
| `META_APP_SECRET` | Valida a assinatura dos webhooks da Meta (recomendado) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Chaves de IA padrão para todas as empresas (opcional) |
| `NODE_ENV=production` | Ativa cookies seguros (HTTPS) |

## Deploy (Railway, Render, VPS)

1. Node 20 ou mais novo. Comando de início: `npm start`.
2. Monte um **volume persistente** e aponte `DATA_DIR` para ele (ex.: `/data`). Sem volume, as sessões do QR Code, o banco e os uploads se perdem a cada deploy.
3. Rode **um único processo**, porque a fila e as sessões do QR Code ficam em memória.
4. API Oficial: configure o webhook na Meta com a URL e o token que aparecem em **Administrador → Webhook**.

## Estrutura

```
server/
  index.js        rotas da API
  db.js           schema SQLite
  queue.js        fila de envio (velocidade, pausas, horário, limite diário)
  ai.js           IA (Claude/OpenAI/Gemini, com reserva)
  settings.js     configurações do administrador + contexto do negócio para a IA
  spreadsheet.js  leitura de planilha e detecção de colunas
  phone.js        normalização de telefones
  render.js       variáveis e spintax
  connections.js  gerenciador de conexões e webhooks
  drivers/        oficial.js, qrcode.js, simulado.js
public/           painel (HTML, CSS e JS, sem etapa de build)
```

## Próximos passos sugeridos

- Planos e cobrança (Asaas, Mercado Pago, Stripe) e limites por plano
- Vários usuários por empresa (vendedores) com permissões
- Integração com o Domma CRM e o Domma Chat por API ou webhook
- Trocar SQLite por Postgres e a fila por Redis/BullMQ quando o volume crescer

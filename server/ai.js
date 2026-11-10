// IA que personaliza cada mensagem (Claude, ChatGPT ou Gemini)
import crypto from 'node:crypto';
import { SECRETS } from './secrets.js';
import { businessContext } from './settings.js';

// ---- chave de API guardada criptografada
export function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRETS.enc, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', SECRETS.enc, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', model: 'claude-haiku-5-5', env: 'ANTHROPIC_API_KEY' },
  openai: { label: 'ChatGPT (OpenAI)', model: 'gpt-4.1-mini', env: 'OPENAI_API_KEY' },
  gemini: { label: 'Gemini (Google)', model: 'gemini-2.5-flash', env: 'GEMINI_API_KEY' },
};

/** Lista ordenada de IAs a tentar: principal e reserva */
export function aiChain(settings) {
  const ia = settings.ia;
  const order = [ia.principal, ia.reserva].filter((p, i, a) => p && PROVIDERS[p] && a.indexOf(p) === i);
  return order.map(provider => ({
    provider, model: ia.provedores?.[provider]?.model || PROVIDERS[provider].model,
    key: decrypt(ia.provedores?.[provider]?.key) || process.env[PROVIDERS[provider].env] || null,
  })).filter(c => c.key);
}
export function hasAI(settings) { return aiChain(settings).length > 0; }

async function call({ provider, model, key }, system, user, temperature = 0.7) {
  const timeout = AbortSignal.timeout(30_000);
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: timeout,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 600, temperature, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Claude respondeu ${r.status}`);
    return j.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  }
  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: timeout,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 600, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `OpenAI respondeu ${r.status}`);
    return j.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: timeout,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 600, temperature } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Gemini respondeu ${r.status}`);
    return j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  }
  throw new Error('Provedor de IA desconhecido');
}

const TAMANHO = { curta: 'Curta: no máximo 3 frases curtas (até ~350 caracteres).', media: 'Média: até 5 frases (até ~600 caracteres).' };
const TEMP = { conservadora: 0.3, equilibrada: 0.7, criativa: 1.0 };

function systemPrompt(settings) {
  return `Você escreve mensagens de WhatsApp em nome de uma empresa, uma mensagem por contato.

INFORMAÇÕES E PLAYBOOK DE VENDAS DA EMPRESA (use só estas informações):
${businessContext(settings) || '(a empresa ainda não preencheu o perfil)'}

REGRAS:
- Português do Brasil, tom natural de conversa de WhatsApp, como uma pessoa real da empresa escreveria. Siga o tom de voz do playbook.
- ${TAMANHO[settings.ia.tamanho] || TAMANHO.curta} Pode usar 1 emoji, no máximo 2.
- Use os dados do contato para personalizar (nome, cidade, veículo etc.), mas só cite o que estiver nos dados.
- NUNCA invente preços, descontos, prazos, endereços, links ou promessas que não estejam nas informações da empresa ou na mensagem base.
- Siga o objetivo e a mensagem base da campanha; mantenha qualquer link, preço ou dado que ela trouxer exatamente como está.
- Termine com a chamada para ação do playbook ou uma pergunta simples.
- Não use saudações genéricas de robô ("Prezado cliente"). Não diga que é uma IA.
- Responda APENAS com o texto final da mensagem, sem aspas e sem comentários.`;
}

export async function personalize(settings, { base, instructions, contact }) {
  const chain = aiChain(settings);
  if (!chain.length) throw new Error('Configure uma IA no Administrador');
  const data = Object.entries(contact).filter(([k, v]) => v && k !== 'telefone').map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`).join('\n');
  const user = `OBJETIVO DA CAMPANHA / INSTRUÇÕES:
${instructions?.trim() || 'Reescreva a mensagem base de forma personalizada para este contato.'}

MENSAGEM BASE (referência de conteúdo):
${base?.trim() || '(sem mensagem base — escreva a partir do objetivo)'}

DADOS DESTE CONTATO:
${data || '- (sem dados além do telefone)'}

Escreva a mensagem para este contato.`;
  let lastErr;
  for (const cfg of chain) {
    try {
      const out = (await call(cfg, systemPrompt(settings), user, TEMP[settings.ia.criatividade] ?? 0.7)).trim().replace(/^["“]|["”]$/g, '').trim();
      if (out) return out.slice(0, 1500);
      lastErr = new Error('A IA não devolveu texto');
    } catch (e) { lastErr = new Error(`${PROVIDERS[cfg.provider].label}: ${e.message}`); }
  }
  throw lastErr;
}

export async function testAI(settings, provider) {
  const p = PROVIDERS[provider] ? provider : settings.ia.principal;
  const cfg = { provider: p, model: settings.ia.provedores?.[p]?.model || PROVIDERS[p].model, key: decrypt(settings.ia.provedores?.[p]?.key) || process.env[PROVIDERS[p].env] };
  if (!cfg.key) throw new Error('Informe a chave de API desta IA');
  const r = await call(cfg, 'Responda apenas: ok', 'Teste de conexão', 0);
  return { ok: true, reply: r.slice(0, 40), provider: PROVIDERS[p].label, model: cfg.model };
}

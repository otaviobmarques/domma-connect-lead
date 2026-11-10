// Configurações do administrador (por empresa)
import { db, parseJSON } from './db.js';

export const DEFAULT_SETTINGS = {
  perfil: { nome: '', segmento: '', cidade: '', site: '', telefone: '', instagram: '', descricao: '', logo: null },
  playbook: {
    produtos: '', publico: '', diferenciais: '', objecoes: '', tom: 'Amigável e direto, como um vendedor atencioso',
    cta: 'Convidar o cliente a responder a mensagem', proibidas: '', exemplos: '',
  },
  ia: {
    principal: 'anthropic', reserva: '',
    provedores: { anthropic: { key: null, model: '' }, openai: { key: null, model: '' }, gemini: { key: null, model: '' } },
    criatividade: 'equilibrada', tamanho: 'curta',
  },
  disparo: {
    velocidade_padrao: 'segura', custom_min: 20, custom_max: 45, custom_every: 20, custom_pause: 3,
    limite_diario: 0, horario_inicio: 8, horario_fim: 20, dias: [1, 2, 3, 4, 5, 6], horario_padrao_ligado: true,
    rodape_optout: 'Para não receber mais mensagens, responda SAIR.',
  },
  digitacao: { ligado: true, velocidade: 18, min: 1.5, max: 8 },
  galeria: [],
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = isObj(base[k]) ? merge(base[k], over[k]) : over[k];
  return out;
}

export async function getSettings(wsOrId) {
  const ws = typeof wsOrId === 'object' ? wsOrId : await db.get('SELECT * FROM workspaces WHERE id=?', [wsOrId]);
  const s = merge(DEFAULT_SETTINGS, parseJSON(ws?.settings_json, {}));
  if (!s.perfil.nome) s.perfil.nome = ws?.name || '';
  return s;
}

export async function saveSettings(wsId, settings) {
  await db.run('UPDATE workspaces SET settings_json=?, name=COALESCE(NULLIF(?, \'\'), name) WHERE id=?', [JSON.stringify(settings), settings.perfil?.nome || '', wsId]);
}

/** Texto que a IA recebe como contexto do negócio */
export function businessContext(s) {
  const p = s.perfil, b = s.playbook;
  const lines = [
    p.nome && `Empresa: ${p.nome}`, p.segmento && `Segmento: ${p.segmento}`, p.cidade && `Cidade/região: ${p.cidade}`,
    p.site && `Site: ${p.site}`, p.telefone && `Telefone: ${p.telefone}`, p.instagram && `Instagram: ${p.instagram}`,
    p.descricao && `Sobre: ${p.descricao}`,
    b.produtos && `\nProdutos e serviços:\n${b.produtos}`, b.publico && `\nPúblico-alvo:\n${b.publico}`,
    b.diferenciais && `\nDiferenciais:\n${b.diferenciais}`, b.objecoes && `\nObjeções comuns e como responder:\n${b.objecoes}`,
    b.tom && `\nTom de voz: ${b.tom}`, b.cta && `Chamada para ação padrão: ${b.cta}`,
    b.proibidas && `\nNUNCA use estas palavras/assuntos: ${b.proibidas}`,
    b.exemplos && `\nExemplos de mensagens que funcionam bem (inspire-se no estilo, não copie):\n${b.exemplos}`,
  ].filter(Boolean);
  return lines.join('\n');
}

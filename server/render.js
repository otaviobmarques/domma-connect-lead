// Personalização: {{variavel}}, {{variavel|valor padrão}} e spintax {Oi|Olá|E aí}
export function saudacao(date = new Date()) {
  const h = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(date));
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function renderVars(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_, key, def) => {
    const k = key.toLowerCase();
    if (k === 'saudacao') return saudacao();
    const v = vars[k];
    return v !== undefined && v !== null && String(v).trim() !== '' ? String(v) : (def ?? '');
  });
}

export function spin(text, rnd = Math.random) {
  let out = String(text || ''), guard = 0;
  // resolve do mais interno para fora; ignora {{ }}
  const re = /(?<!\{)\{([^{}]*\|[^{}]*)\}(?!\})/;
  while (re.test(out) && guard++ < 500) {
    out = out.replace(re, (_, body) => {
      const opts = body.split('|');
      return opts[Math.floor(rnd() * opts.length)];
    });
  }
  return out;
}

export function renderMessage(text, vars) {
  return spin(renderVars(text, vars)).replace(/[ \t]+\n/g, '\n').trim();
}

export function usedVariables(text) {
  return [...String(text || '').matchAll(/\{\{\s*([a-z0-9_]+)/gi)].map(m => m[1].toLowerCase());
}

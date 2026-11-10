// Modelos prontos de mensagem (para conexões QR Code / texto livre)
export const MODELOS = [
  // ---- Automotivo
  { id: 'vistoria-lembrete', categoria: 'Automotivo', titulo: 'Lembrete de vistoria',
    texto: '{{saudacao}}, {{primeiro_nome}}! {Tudo bem?|Tudo certo?}\n\nPassando para lembrar da vistoria do seu veículo {{placa|}} agendada para {{data|em breve}}.\n\nQualquer dúvida é só responder esta mensagem. 🚗' },
  { id: 'laudo-pronto', categoria: 'Automotivo', titulo: 'Laudo pronto',
    texto: '{Olá|Oi}, {{primeiro_nome}}! ✅\n\nSeu laudo do veículo {{placa|}} já está pronto. {Pode retirar quando quiser|Já está disponível para você}.\n\nPrecisando de algo, estamos à disposição.' },
  { id: 'transferencia', categoria: 'Automotivo', titulo: 'Oferta para transferência',
    texto: '{{saudacao}}, {{primeiro_nome}}!\n\nVai vender ou comprar um veículo? Fazemos a vistoria de transferência {rápida|sem burocracia} e com laudo na hora.\n\nQuer que eu reserve um horário para você?' },
  { id: 'pesquisa-veicular', categoria: 'Automotivo', titulo: 'Pesquisa veicular para lojista',
    texto: '{Olá|Oi}, {{primeiro_nome}}! {Tudo bem?|Como vai?}\n\nAntes de fechar a compra do próximo carro da loja, consulte o histórico completo: leilão, sinistro, débitos, gravame e muito mais.\n\nQuer conhecer os pacotes para lojistas?' },
  { id: 'licenciamento', categoria: 'Automotivo', titulo: 'Aviso de licenciamento',
    texto: '{{saudacao}}, {{primeiro_nome}}!\n\nO licenciamento dos veículos com placa final {{final_placa|do seu carro}} {vence em breve|está chegando}. Evite multa e regularize com antecedência.\n\nPosso te ajudar com isso?' },
  // ---- Geral
  { id: 'promocao', categoria: 'Geral', titulo: 'Promoção',
    texto: '{{saudacao}}, {{primeiro_nome}}! 🎉\n\n{Preparamos|Separamos} uma condição especial para você: {{oferta|desconto exclusivo por tempo limitado}}.\n\nQuer saber mais? É só responder aqui.' },
  { id: 'cobranca', categoria: 'Geral', titulo: 'Lembrete de pagamento',
    texto: '{Olá|Oi}, {{primeiro_nome}}, {tudo bem?|como vai?}\n\nPassando para lembrar que o pagamento de {{valor|sua fatura}} vence em {{vencimento|breve}}.\n\nSe já pagou, por favor desconsidere. 🙏' },
  { id: 'reativacao', categoria: 'Geral', titulo: 'Reativar cliente antigo',
    texto: '{{saudacao}}, {{primeiro_nome}}! {Quanto tempo!|Faz tempo que não conversamos!}\n\nLembramos de você e {queríamos saber|gostaríamos de saber} se podemos te ajudar com algo novamente.\n\nTemos novidades que podem te interessar. 😉' },
  { id: 'boas-vindas', categoria: 'Geral', titulo: 'Boas-vindas',
    texto: '{Olá|Oi}, {{primeiro_nome}}! Seja muito bem-vindo(a)! 🙌\n\nA partir de agora você recebe por aqui nossas novidades e avisos importantes.\n\nSe precisar de algo, é só chamar.' },
  { id: 'evento', categoria: 'Geral', titulo: 'Convite para evento',
    texto: '{{saudacao}}, {{primeiro_nome}}!\n\nVocê está convidado(a) para {{evento|nosso evento}} no dia {{data|em breve}}. {Vai ser incrível!|Contamos com sua presença!}\n\nPosso confirmar seu nome na lista?' },
];

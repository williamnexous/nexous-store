export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (process.env.VERCEL_ENV !== 'preview') {
    return res.status(404).json({
      erro: 'Teste disponível apenas em Preview.'
    });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ erro: 'Use GET.' });
  }

  const token = process.env.OTL_SANDBOX_TOKEN?.trim();
  const base = process.env.OTL_SANDBOX_API_URL
    ?.trim()
    .replace(/\/+$/, '');

  if (
    !token?.startsWith('otl_sbx_') ||
    base !== 'https://api-sandbox.otlshoes.com.br/v1'
  ) {
    return res.status(500).json({
      erro: 'Confira as variáveis OTL_SANDBOX no ambiente Preview.'
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const resposta = await fetch(
      `${base}/produtos?limite=2&comEstoque=true`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: controller.signal,
        redirect: 'error'
      }
    );

    if (!resposta.ok) {
      return res.status(502).json({
        erro: 'A OTL não concluiu a consulta.',
        statusOTL: resposta.status
      });
    }

    const resultado = await resposta.json();

    if (!Array.isArray(resultado.dados)) {
      return res.status(502).json({
        erro: 'Resposta diferente do formato esperado.'
      });
    }

    const produtos = resultado.dados.map(p => ({
      sku: p.sku,
      nome: p.titulo,
      imagem: p.imagem,
      precoSugerido: p.precoSugerido,
      ativo: p.ativo,
      numeracoes: Array.isArray(p.numeracoes)
        ? p.numeracoes.map(n => ({
            numeracao: n.numeracao,
            skuVariacao: n.skuVariacao,
            estoque: n.estoque
          }))
        : []
    }));

    return res.status(200).json({
      conexao: 'OK',
      ambiente: 'sandbox',
      aviso: 'Teste: nenhum produto salvo e nenhum pedido criado.',
      produtos
    });
  } catch {
    return res.status(502).json({
      erro: 'Não foi possível consultar a OTL. Tente novamente.'
    });
  } finally {
    clearTimeout(timer);
  }
}

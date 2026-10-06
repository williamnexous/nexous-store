import { createHash, timingSafeEqual } from 'node:crypto';

const PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXOUS — Importação de teste</title>
<style>body{margin:0;background:#101010;color:#eee;font:16px Arial;padding:24px}main{max-width:1000px;margin:auto}input,button{font:inherit;padding:14px;border:1px solid #555;border-radius:8px}input{background:#222;color:white;width:100%;box-sizing:border-box}button{background:#d7ff57;margin:12px 8px 0 0}button:disabled{opacity:.5}p{line-height:1.6;color:#bbb}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}article{background:#202020;padding:16px;border-radius:12px}img{width:100%;aspect-ratio:1;object-fit:contain}li{margin:8px 0}#status{white-space:pre-wrap}</style>
<main><h1>NEXOUS / catálogo de teste</h1><p>Importa o catálogo sandbox para a tabela de teste. Os preços exibidos são sugestões da OTL. Esta página não realiza compras.</p>
<form id="form"><label>Senha de importação<input id="secret" type="password" required minlength="32" autocomplete="off"></label><button id="start">IMPORTAR CATÁLOGO DE TESTE</button><button id="stop" type="button" disabled>PARAR</button></form><p id="status" role="status" aria-live="polite"></p><div id="grid"></div></main>
<script>
const form=document.getElementById('form'),start=document.getElementById('start'),stop=document.getElementById('stop'),status=document.getElementById('status'),grid=document.getElementById('grid');
let stopped=false;
stop.onclick=()=>{stopped=true;stop.disabled=true;status.textContent='Parando após a página atual…';};
function show(p){
 const card=document.createElement('article');
 if(p.image_url){const image=document.createElement('img');image.src=p.image_url;image.alt=p.name;image.loading='lazy';card.append(image);}
 const title=document.createElement('h2');title.textContent=p.name;card.append(title);
 const price=document.createElement('p');price.textContent=p.price===null?'Preço não informado':Number(p.price).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})+' — sugerido';card.append(price);
 const list=document.createElement('ul');
 for(const n of p.numeracoes){const li=document.createElement('li');li.textContent=n.numeracao+': '+(n.estoque===null?'estoque desconhecido':n.estoque===0?'indisponível':n.estoque+' pares');list.append(li);}
 card.append(list);grid.append(card);
}
form.onsubmit=async(event)=>{
 event.preventDefault();if(start.disabled)return;
 const password=document.getElementById('secret').value;document.getElementById('secret').value='';
 start.disabled=true;stop.disabled=false;stopped=false;grid.replaceChildren();let cursor=null,total=0;const seen=new Set();
 try{
  for(let page=0;page<1000;page++){
   status.textContent='Importando página '+(page+1)+'… '+total+' produtos salvos.';
   const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-Import-Secret':password},body:JSON.stringify({cursor}),signal:AbortSignal.timeout(15000)});
   const data=await response.json();if(!response.ok)throw new Error(data.erro||'Falha na importação.');
   total+=data.produtos.length;data.produtos.forEach(show);
   if(stopped){status.textContent='Importação interrompida. '+total+' produtos salvos na tabela de teste.';return;}
   if(!data.temMais){status.textContent='Concluído: '+total+' produtos salvos na tabela de teste. Nenhum pedido criado.';return;}
   if(!data.proximoCursor||seen.has(data.proximoCursor))throw new Error('Paginação repetida ou inválida.');
   cursor=data.proximoCursor;seen.add(cursor);
   await new Promise(resolve=>setTimeout(resolve,2200));
   if(stopped){status.textContent='Importação interrompida. '+total+' produtos salvos.';return;}
  }
  throw new Error('Limite de páginas atingido.');
 }catch(error){status.textContent='Importação incompleta: '+error.message+' '+total+' produtos já confirmados. Você pode tentar novamente; os SKUs serão atualizados.';}
 finally{start.disabled=false;stop.disabled=true;}
};
</script></html>`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (process.env.VERCEL_ENV !== 'preview') {
    return res.status(404).end();
  }

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({
      erro: 'Método não permitido.'
    });
  }

  const secret = process.env.OTL_TEST_SYNC_SECRET;
  const supplied = req.headers['x-import-secret'];

  if (!secret || secret.length < 32) {
    return res.status(500).json({
      erro: 'Confira OTL_TEST_SYNC_SECRET: mínimo de 32 caracteres.'
    });
  }

  const hash = value =>
    createHash('sha256').update(value).digest();

  if (
    typeof supplied !== 'string' ||
    supplied.length > 1024 ||
    !timingSafeEqual(hash(secret), hash(supplied))
  ) {
    return res.status(401).json({
      erro: 'Senha de importação incorreta.'
    });
  }

  const token = process.env.OTL_SANDBOX_TOKEN?.trim();
  const base = process.env.OTL_SANDBOX_API_URL
    ?.trim().replace(/\/+$/, '');
  const db = process.env.OTL_TEST_SUPABASE_URL
    ?.trim().replace(/\/+$/, '');
  const key = process.env.OTL_TEST_SUPABASE_SERVICE_ROLE_KEY
    ?.trim();

  if (
    !token?.startsWith('otl_sbx_') ||
    base !== 'https://api-sandbox.otlshoes.com.br/v1' ||
    db !== 'https://tcszjspirwwxrkabhtgi.supabase.co' ||
    !key
  ) {
    return res.status(500).json({
      erro: 'Confira as variáveis OTL_SANDBOX e OTL_TEST no Preview.'
    });
  }

  const cursor = req.body?.cursor;

  if (
    cursor != null &&
    (
      typeof cursor !== 'string' ||
      !cursor ||
      cursor.length > 4096
    )
  ) {
    return res.status(400).json({
      erro: 'Cursor inválido.'
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const url = new URL(base + '/produtos');
    url.searchParams.set('limite', '50');

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token
      },
      signal: controller.signal,
      redirect: 'error'
    });

    if (!response.ok) {
      return res.status(502).json({
        erro: 'Falha na consulta à OTL.',
        statusOTL: response.status
      });
    }

    const data = await response.json();

    if (
      !Array.isArray(data.dados) ||
      typeof data.paginacao?.temMais !== 'boolean'
    ) {
      throw new Error('Formato');
    }

    if (
      data.paginacao.temMais &&
      (
        typeof data.paginacao.proximoCursor !== 'string' ||
        !data.paginacao.proximoCursor
      )
    ) {
      throw new Error('Paginação');
    }

    const rows = data.dados.map(p => {
      if (
        typeof p.sku !== 'string' ||
        !p.sku ||
        typeof p.titulo !== 'string' ||
        !p.titulo ||
        typeof p.ativo !== 'boolean' ||
        !Array.isArray(p.numeracoes)
      ) {
        throw new Error('Produto');
      }

      const price = p.precoSugerido == null
        ? null
        : Number(p.precoSugerido);

      if (
        price !== null &&
        (
          !Number.isFinite(price) ||
          price <= 0
        )
      ) {
        throw new Error('Preço');
      }

      const numeracoes = p.numeracoes.map(n => {
        if (
          typeof n.numeracao !== 'string' ||
          !(
            n.estoque === null ||
            Number.isInteger(n.estoque) && n.estoque >= 0
          )
        ) {
          throw new Error('Estoque');
        }

        return {
          numeracao: n.numeracao,
          skuVariacao: n.skuVariacao ?? null,
          estoque: n.estoque
        };
      });

      return {
        sku: p.sku,
        name: p.titulo,
        image_url:
          typeof p.imagem === 'string' &&
          /^https:\/\//.test(p.imagem)
            ? p.imagem
            : null,
        price,
        numeracoes,
        categorias: Array.isArray(p.categorias)
          ? p.categorias.map(c => ({
              id: String(c.id),
              nome: String(c.nome)
            }))
          : [],
        active: p.ativo,
        atualizado_em: p.atualizadoEm ?? null,
        sincronizado_em: new Date().toISOString()
      };
    });

    const produtos = [
      ...new Map(rows.map(p => [p.sku, p])).values()
    ];

    if (produtos.length) {
      const saved = await fetch(
        db + '/rest/v1/otl_products_sandbox?on_conflict=sku',
        {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(produtos),
          signal: controller.signal,
          redirect: 'error'
        }
      );

      if (!saved.ok) {
        return res.status(502).json({
          erro: 'Falha ao salvar na tabela de teste.',
          statusBanco: saved.status
        });
      }
    }

    return res.status(200).json({
      produtos,
      temMais: data.paginacao.temMais,
      proximoCursor: data.paginacao.proximoCursor ?? null
    });
  } catch {
    return res.status(502).json({
      erro: 'Consulta ou gravação não concluída. Confira a configuração e tente novamente.'
    });
  } finally {
    clearTimeout(timer);
  }
}
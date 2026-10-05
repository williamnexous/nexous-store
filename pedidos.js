import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const sb=createClient('https://tcszjspirwwxrkabhtgi.supabase.co','sb_publishable_bZIkwmhElVzFMsGbk0bBgw_eFVWJuXV');
const admin=document.body.dataset.admin==='true';
const $=id=>document.getElementById(id);
const stages=['aguardando','preparando','enviado','em_transito','entregue'];
const labels=['Aguardando preparação','Preparando pedido','Enviado','Em transporte','Entregue'];
const paymentLabels={pending:'Aguardando pagamento',pendente:'Aguardando pagamento',approved:'Pago',pago:'Pago',in_process:'Pagamento em análise',processando:'Pagamento em análise',rejected:'Pagamento rejeitado',rejeitado:'Pagamento rejeitado',cancelled:'Pagamento cancelado',cancelado:'Pagamento cancelado',refunded:'Reembolsado',reembolsado:'Reembolsado',charged_back:'Estornado',estornado:'Estornado'};
let records=[],next=null,busy=false;
const money=n=>Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('pt-BR'):'Não informada';
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function safeLink(s){try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
async function request(method='GET',body,offset=0){
 const {data:{session}}=await sb.auth.getSession();
 if(!session)throw new Error('Entre na sua conta para acessar os pedidos.');
 const response=await fetch('/api/orders?scope='+(admin?'admin':'customer')+'&offset='+offset,{method,headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Não foi possível acessar os pedidos.');return result;
}
function field(form,label,key,value,type='text'){
 const wrapper=el('label',label);const input=el(type==='textarea'?'textarea':'input');input.name=key;input.value=value||'';
 if(type!=='textarea')input.type=type;
 input.maxLength=key==='tracking_url'||key==='delivery_note'?1000:key==='carrier'?100:120;
 wrapper.append(input);form.append(wrapper);return input;
}
function render(){
 $('orders').replaceChildren();const term=$('search').value.toLocaleLowerCase('pt-BR');
 const list=records.filter(o=>[o.id,o.customer_name,o.customer_email,...(o.items||[]).map(i=>i.product_name)].join(' ').toLocaleLowerCase('pt-BR').includes(term));
 for(const o of list){
  const card=el('article',undefined,'card');const row=el('div',undefined,'row');row.append(el('h2','Pedido '+o.id.slice(0,8).toUpperCase()),el('span',paymentLabels[o.status]||'Pagamento: '+o.status,'badge'));card.append(row);
  card.append(el('p','Realizado em '+date(o.created_at)+' · '+money(o.total),'muted'));
  const details=el('details');details.append(el('summary','Produtos e endereço de entrega'));const items=el('ul',undefined,'items');
  for(const item of o.items||[])items.append(el('li',`${item.quantity} × ${item.product_name}${item.size?' · '+item.size:''}${item.color?' · Cor: '+item.color:''} — ${money(item.unit_price)}/un.`));
  if(o.subtotal!==null&&o.subtotal!==undefined){items.append(el('li','Produtos: '+money(o.subtotal)),el('li','Entrega padrão: '+(Number(o.shipping_amount)?money(o.shipping_amount):'Grátis')));}
  details.append(items,el('p',o.customer_name));
  if(admin)details.append(el('p',o.customer_email));
  details.append(el('p',[o.rua,o.numero,o.complemento,o.bairro].filter(Boolean).join(', ')),el('p',[o.cidade,o.estado,o.cep?'CEP '+o.cep:''].filter(Boolean).join(' · ')));card.append(details);
  const paid=['approved','pago'].includes(o.status);const stage=stages.indexOf(o.delivery_status||'aguardando');
  card.append(el('h3',paid?(labels[stage]||'Aguardando preparação'):'Entrega aguardando pagamento aprovado'));
  if(paid){const timeline=el('ol',undefined,'timeline');labels.forEach((label,i)=>{const li=el('li',label,i<=stage?'done':'');if(i===stage){li.classList.add('current');li.setAttribute('aria-current','step');}timeline.append(li);});card.append(timeline);}
  card.append(el('p','Previsão de entrega: '+date(o.estimated_delivery)));
  if(o.carrier)card.append(el('p','Transportadora: '+o.carrier));
  if(o.tracking_code)card.append(el('p','Código de rastreamento: '+o.tracking_code));
  const url=safeLink(o.tracking_url);if(url){const link=el('a','Acompanhar na transportadora','button');link.href=url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
  if(o.delivery_note)card.append(el('p',o.delivery_note));
  if(o.delivery_updated_at)card.append(el('small','Entrega atualizada em '+new Date(o.delivery_updated_at).toLocaleString('pt-BR')));
  if(admin){
   const box=el('details');box.append(el('summary','Atualizar entrega'));const form=el('form');const label=el('label','Etapa da entrega');const select=el('select');select.name='delivery_status';
   stages.forEach((value,i)=>{const opt=el('option',labels[i]);opt.value=value;select.append(opt);});select.value=o.delivery_status||'aguardando';label.append(select);form.append(label);
   field(form,'Transportadora','carrier',o.carrier);field(form,'Código de rastreamento','tracking_code',o.tracking_code);field(form,'Link HTTPS da transportadora','tracking_url',o.tracking_url,'url');field(form,'Data prevista (opcional)','estimated_delivery',o.estimated_delivery,'date');field(form,'Informação visível para o cliente','delivery_note',o.delivery_note,'textarea');
   const note=el('p','Essa alteração não confirma nem modifica o pagamento.','muted');const save=el('button','Salvar entrega','primary');save.type='submit';const feedback=el('p');feedback.setAttribute('role','status');form.append(note,save,feedback);
   form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;feedback.textContent='Salvando...';try{const values=Object.fromEntries(new FormData(form));const result=await request('PATCH',{...values,id:o.id,delivery_updated_at:o.delivery_updated_at});records=records.map(old=>old.id===o.id?{...result.order,items:old.items}:old);render();message('Entrega atualizada. O cliente já pode consultar a informação.');}catch(e){feedback.textContent=e.message;}finally{save.disabled=false;}});
   box.append(form);card.append(box);
  }
  $('orders').append(card);
 }
 if(!list.length)$('orders').append(el('p',term?'Nenhum pedido corresponde à busca.':'Nenhum pedido encontrado para esta conta.','muted'));
}
async function load(append=false){if(busy)return;busy=true;$('refresh').disabled=true;$('more').disabled=true;message('Carregando pedidos...');try{const data=await request('GET',null,append?next:0);records=append?[...records,...data.orders]:data.orders;next=data.next_offset;$('more').hidden=next===null;$('filter').hidden=false;render();message('');}catch(e){message(e.message,true);}finally{busy=false;$('refresh').disabled=false;$('more').disabled=false;}}
async function account(){const {data:{session}}=await sb.auth.getSession();$('login').hidden=!!session;$('account').hidden=!session;if(session){$('identity').textContent=session.user.email;await load();}else{records=[];$('orders').replaceChildren();$('filter').hidden=true;$('more').hidden=true;}}
$('login').addEventListener('submit',async event=>{event.preventDefault();const button=$('login').querySelector('button');button.disabled=true;message('Entrando...');try{const {error}=await sb.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw error;$('password').value='';await account();}catch(e){message(e.message,true);}finally{button.disabled=false;}});
$('logout').onclick=async()=>{const {error}=await sb.auth.signOut();if(error){message(error.message,true);return;}message('');await account();};
$('refresh').onclick=()=>load();$('more').onclick=()=>load(true);$('search').oninput=render;
account();

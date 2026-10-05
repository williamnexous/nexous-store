export const shippingRates = {
 Sudeste:{states:['SP','RJ','MG','ES'],cents:2490},
 Sul:{states:['RS','SC','PR'],cents:2990},
 'Centro-Oeste':{states:['DF','GO','MT','MS'],cents:3490},
 Nordeste:{states:['AL','BA','CE','MA','PB','PE','PI','RN','SE'],cents:3990},
 Norte:{states:['AC','AP','AM','PA','RO','RR','TO'],cents:4990}
};
export class ShippingError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function totalsForRegion(subtotalCents,uf){
 if(!Number.isSafeInteger(subtotalCents)||subtotalCents<0)throw new ShippingError('Valor dos produtos inválido.');
 const entry=Object.entries(shippingRates).find(([,rate])=>rate.states.includes(uf));
 if(!entry)throw new ShippingError('Estado de entrega inválido.');
 const shipping=subtotalCents>=34990||subtotalCents===0?0:entry[1].cents;
 return {subtotal:subtotalCents/100,shipping_amount:shipping/100,total:(subtotalCents+shipping)/100,shipping_region:entry[0],discount_amount:0};
}
const cepCache=new Map();
export async function lookupCep(input,request=fetch){
 if(typeof input!=='string'||!/^\d{5}-?\d{3}$/.test(input.trim()))throw new ShippingError('Digite um CEP válido com 8 números.');
 const cep=input.replace(/\D/g,'');
 const cached=cepCache.get(cep);if(cached&&cached.until>Date.now())return cached.value;
 let response,data;
 try{response=await request('https://viacep.com.br/ws/'+cep+'/json/',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();data=await response.json();}
 catch{throw new ShippingError('Não foi possível consultar o CEP. Tente novamente.',503);}
 if(data.erro)throw new ShippingError('CEP não encontrado. Confira os números.');
 if(!Object.values(shippingRates).some(rate=>rate.states.includes(data.uf)))throw new ShippingError('Não foi possível identificar a região do CEP.',503);
 const value={cep,uf:data.uf,cidade:String(data.localidade||''),rua:String(data.logradouro||''),bairro:String(data.bairro||'')};
 if(cepCache.size>=500)cepCache.delete(cepCache.keys().next().value);
 cepCache.set(cep,{until:Date.now()+3600000,value});return value;
}
export async function catalogSubtotal(sb,items){
 if(!Array.isArray(items)||items.length===0||items.length>50)throw new ShippingError('Carrinho inválido.');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const ids=[...new Set(items.map(i=>i?.product_id||i?.id))];
 if(ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw new ShippingError('Produto inválido.');
 const {data:products,error}=await sb.from('products').select('id,price').in('id',ids).eq('active',true);
 if(error)throw new ShippingError('Não foi possível conferir os produtos.',503);
 if(products?.length!==ids.length)throw new ShippingError('Um produto não está disponível. Atualize o carrinho.');
 const byId=new Map(products.map(p=>[p.id,p]));let cents=0;
 for(const item of items){
  const quantity=Number(item.quantity),price=Math.round(Number(byId.get(item.product_id||item.id)?.price)*100);
  if(!Number.isInteger(quantity)||quantity<1||quantity>10||!Number.isSafeInteger(price)||price<=0)throw new ShippingError('Quantidade ou preço inválido.');
  cents+=price*quantity;
 }
 return cents;
}

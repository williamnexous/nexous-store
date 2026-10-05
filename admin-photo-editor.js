const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function cropRectangle(width,height,zoom=1,x=50,y=50){
 const side=Math.min(width,height)/clamp(Number(zoom)||1,1,3);
 return {x:(width-side)*clamp(Number(x)||0,0,100)/100,y:(height-side)*clamp(Number(y)||0,0,100)/100,width:side,height:side};
}
const css=document.createElement('style');
css.textContent=`#photoCropDialog{background:#141414;color:#f4f4ef;border:1px solid #444;border-radius:14px;width:min(480px,calc(100% - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:22px;font-family:Arial,sans-serif}#photoCropDialog::backdrop{background:#000c}#photoCropDialog h2{margin:0 0 8px;font-size:23px}#photoCropDialog p{font-size:13px;line-height:1.5;color:#bbb}#photoCropDialog canvas{display:block;width:100%;aspect-ratio:1;background:#222;border-radius:8px;touch-action:none;cursor:grab}#photoCropDialog label{display:block;color:#ddd;font-size:13px;margin:15px 0 5px}#photoCropDialog input{width:100%;accent-color:#d7ff57}#photoCropDialog .crop-actions{display:flex;gap:10px;margin-top:20px}#photoCropDialog button{flex:1;padding:14px 10px;border:1px solid #444;border-radius:7px;background:#242424;color:white;font-weight:bold;cursor:pointer}#photoCropDialog #cropApply{background:#d7ff57;color:#111;border-color:#d7ff57}#photoCropDialog button:disabled{opacity:.5;cursor:wait}#photoCropDialog :focus-visible{outline:2px solid #d7ff57;outline-offset:3px}`;
document.head.append(css);
const dialog=document.createElement('dialog');dialog.id='photoCropDialog';dialog.setAttribute('aria-labelledby','cropTitle');
dialog.innerHTML=`<h2 id="cropTitle">Cortar foto</h2><p>Ajuste o enquadramento quadrado. Arraste a foto ou use os controles abaixo.</p><canvas id="cropPreview" width="600" height="600" aria-label="Prévia do corte"></canvas><label for="cropZoom">Zoom</label><input id="cropZoom" type="range" min="1" max="3" step="0.01" value="1"><label for="cropX">Posição horizontal</label><input id="cropX" type="range" min="0" max="100" step="1" value="50"><label for="cropY">Posição vertical</label><input id="cropY" type="range" min="0" max="100" step="1" value="50"><p id="cropStatus" role="status" aria-live="polite">A foto só será enviada ao salvar o produto.</p><div class="crop-actions"><button id="cropOriginal" type="button">Usar original</button><button id="cropApply" type="button">Aplicar corte</button></div>`;
document.body.append(dialog);
const control=id=>dialog.querySelector('#'+id);
let editing=false;
async function editPhoto(file){
 if(!file.type.startsWith('image/'))throw new Error('Escolha um arquivo de imagem.');
 const url=URL.createObjectURL(file),image=new Image();
 try{
 await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Não foi possível abrir a foto. Tente usar JPG ou PNG.'));image.src=url;});
 for(const [id,value] of [['cropZoom',1],['cropX',50],['cropY',50]])control(id).value=value;
 const preview=control('cropPreview'),ctx=preview.getContext('2d');if(!ctx)throw new Error('O navegador não conseguiu abrir o editor de fotos.');
 const rect=()=>cropRectangle(image.naturalWidth,image.naturalHeight,control('cropZoom').value,control('cropX').value,control('cropY').value);
 function draw(){const r=rect();ctx.clearRect(0,0,600,600);ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,600,600);}
 const bindings=[];function listen(target,event,handler){target.addEventListener(event,handler);bindings.push(()=>target.removeEventListener(event,handler));}
 let drag=null;
 listen(preview,'pointerdown',e=>{drag={x:e.clientX,y:e.clientY,px:Number(control('cropX').value),py:Number(control('cropY').value)};preview.setPointerCapture?.(e.pointerId);});
 listen(preview,'pointermove',e=>{if(!drag)return;const r=rect(),display=preview.getBoundingClientRect().width||600,scale=r.width/display;
 if(image.naturalWidth>r.width)control('cropX').value=clamp(drag.px-(e.clientX-drag.x)*scale/(image.naturalWidth-r.width)*100,0,100);
 if(image.naturalHeight>r.height)control('cropY').value=clamp(drag.py-(e.clientY-drag.y)*scale/(image.naturalHeight-r.height)*100,0,100);draw();});
 listen(preview,'pointerup',()=>drag=null);listen(preview,'pointercancel',()=>drag=null);
 for(const id of ['cropZoom','cropX','cropY'])listen(control(id),'input',draw);
 draw();control('cropStatus').textContent='A foto só será enviada ao salvar o produto.';control('cropApply').disabled=false;control('cropOriginal').disabled=false;
 dialog.showModal();control('cropZoom').focus();
 try{return await new Promise(resolve=>{
 let finishing=false;
 function original(){if(finishing)return;finishing=true;resolve(file);}
 listen(control('cropOriginal'),'click',original);
 listen(dialog,'cancel',e=>{e.preventDefault();original();});
 listen(control('cropApply'),'click',async()=>{
 if(finishing)return;finishing=true;control('cropApply').disabled=true;control('cropOriginal').disabled=true;
 try{
 const r=rect(),output=document.createElement('canvas');output.width=output.height=Math.max(1,Math.min(1200,Math.round(r.width)));
 const out=output.getContext('2d');if(!out)throw new Error('Não foi possível preparar o corte.');
 const mime=file.type==='image/png'?'image/png':'image/jpeg';if(mime==='image/jpeg'){out.fillStyle='#fff';out.fillRect(0,0,output.width,output.height);}
 out.drawImage(image,r.x,r.y,r.width,r.height,0,0,output.width,output.height);
 const blob=await new Promise(resolve=>output.toBlob(resolve,mime,.92));if(!blob)throw new Error('Não foi possível salvar o corte.');
 resolve(new File([blob],file.name.replace(/\.[^.]+$/,'')+'-cortada.'+(mime==='image/png'?'png':'jpg'),{type:mime,lastModified:Date.now()}));
 }catch(error){finishing=false;control('cropStatus').textContent=error.message;control('cropApply').disabled=false;control('cropOriginal').disabled=false;}
 });
 });}finally{bindings.forEach(remove=>remove());dialog.close();}
 }finally{URL.revokeObjectURL(url);}
}
document.addEventListener('change',async event=>{
 const input=event.target;
 if(!(input instanceof HTMLInputElement)||input.type!=='file'||!['imageFile','imageFile2'].includes(input.id)||event.cropProcessed||!input.files.length)return;
 event.stopImmediatePropagation();
 if(editing)return;
 editing=true;
 const focusBefore=document.activeElement;
 const controls=[...document.querySelectorAll('#productForm button,#productForm input[type="file"],#closeForm,#cancelForm')];
 const states=controls.map(el=>[el,el.disabled]);controls.forEach(el=>el.disabled=true);
 const selected=[...input.files];
 try{
 const transfer=new DataTransfer();for(const file of selected)transfer.items.add(await editPhoto(file));input.files=transfer.files;
 }catch(error){alert(error.message||'Não foi possível cortar a foto. A foto original será usada.');}
 finally{
 states.forEach(([el,disabled])=>el.disabled=disabled);editing=false;
 const change=new Event('change',{bubbles:true});change.cropProcessed=true;input.dispatchEvent(change);focusBefore?.focus?.();
 }
},true);
document.addEventListener('submit',event=>{if(editing&&event.target.id==='productForm'){event.preventDefault();event.stopImmediatePropagation();}},true);

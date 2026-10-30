export async function requestJson(path,{method='GET',body,signal}={}){
 const r=await fetch('/api/'+path,{method,credentials:'same-origin',cache:'no-store',signal,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 let data;try{data=await r.json()}catch{throw Error('The server returned an invalid response. Check your connection and retry.');}
 if(!r.ok)throw Object.assign(new Error(data.error||'The request failed. Please try again.'),{status:r.status});return data;
}
export async function readAuthStatus(signal){
 const data=await requestJson('auth/status',{signal});
 if(typeof data.configured!=='boolean'||data.apiVersion!==8||!Object.hasOwn(data,'user'))throw Error('The app and server versions do not match. Restart using the latest project and refresh this page.');
 return data;
}

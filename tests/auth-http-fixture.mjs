import assert from 'node:assert/strict';
// HTTP integration uses a real synthetic account with production account auth enabled.
export async function registerHttpFixture(appUrl) {
 const bootstrap=await fetch(appUrl+'/api/session');assert.equal(bootstrap.status,200);
 const csrf=bootstrap.headers.get('set-cookie').split(';')[0];
 const registered=await fetch(appUrl+'/api/auth/register',{method:'POST',headers:{Cookie:csrf,Origin:appUrl,'Content-Type':'application/json'},body:JSON.stringify({email:'http-fixture@example.test',password:'synthetic-http-only-password',name:'HTTP integration fixture'})});
 assert.equal(registered.status,201,await registered.clone().text());
 const auth=registered.headers.get('set-cookie').split(';')[0];return csrf+'; '+auth;
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { CookieStore,douyinBrowserCookieFingerprint,type BrowserCookie } from './cookies'
import { LoginManager } from './login'
import type { EmbeddedLoginDriver,EmbeddedLoginRequest } from './embeddedLoginContracts'
import type { DouyinSigningMaterial,DouyinSigningSnapshot } from '../server/douyin/signingMaterial'
import { syntheticDouyinSigningMaterial } from '../server/douyin/fixtures/signingFixture'

let root:string
const managers:LoginManager[]=[]
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-signing-login-'))})
afterEach(async()=>{await Promise.all(managers.splice(0).map(value=>value.dispose()));fs.rmSync(root,{recursive:true,force:true});vi.restoreAllMocks()})
const cookie:BrowserCookie={domain:'.douyin.com',path:'/',secure:true,httpOnly:true,name:'sessionid',value:'synthetic-embedded-session',session:true}
function snapshot():DouyinSigningSnapshot {
  const value=syntheticDouyinSigningMaterial()
  return {origin:value.origin,accountUid:value.accountUid,cookieFingerprint:value.cookieFingerprint,userAgent:value.userAgent,
    cryptData:JSON.stringify({ec_privateKey:value.privateKeyPem,ec_publicKey:value.publicKeyPem}),
    serverData:JSON.stringify({ticket:value.ticket,ts_sign:value.tsSign,client_cert:value.clientCertificate})}
}
function setup(driver?:EmbeddedLoginDriver) {
  let saved:DouyinSigningMaterial|null=null
  const signing={save:vi.fn(async(value:DouyinSigningMaterial)=>{saved=value}),clear:vi.fn(async()=>{saved=null}),
    load:vi.fn(async(lookup:{cookieFingerprint:string;accountUid?:string})=>saved?.cookieFingerprint===lookup.cookieFingerprint
      && (!lookup.accountUid || lookup.accountUid===saved.accountUid) ? saved : null),dispose:vi.fn()}
  const embedded=driver ?? {login:vi.fn(async(request:EmbeddedLoginRequest)=>{await request.captureDouyinSigning?.(snapshot());return[cookie]})}
  const manager=new LoginManager(root,{embeddedDriver:embedded,douyinSigning:signing})
  managers.push(manager)
  return{manager,signing,embedded}
}
describe('verified login and encrypted-signing lifecycle integration',()=>{
  it('binds capture to the persisted authentication and returns only readiness metadata',async()=>{
    const f=setup()
    const result=await f.manager.login('douyin')
    expect(result).toMatchObject({signingReady:true,authKeysPresent:['sessionid']})
    expect(f.signing.clear).toHaveBeenCalledOnce()
    expect(f.signing.save).toHaveBeenCalledOnce()
    const material=f.signing.save.mock.calls[0]![0]
    const header=await f.manager.cookieHeader('douyin','https://live.douyin.com/webcast/user/me/')
    expect(material.cookieFingerprint).toBe(douyinBrowserCookieFingerprint([cookie]))
    expect(await f.manager.douyinSigningMaterial(header,undefined,'12345')).toEqual(material)
    expect(await f.manager.douyinSigningMaterial('sessionid=synthetic-other')).toBeNull()
    expect(await f.manager.douyinSigningMaterial(header,undefined,'99999')).toBeNull()
    expect(JSON.stringify(result)).not.toContain(material.ticket)
    expect(JSON.stringify(await f.manager.loginStatus())).not.toContain(material.privateKeyPem)
    await f.manager.logout('douyin')
    expect(f.signing.clear).toHaveBeenCalledTimes(2)
    expect((await f.manager.loginStatus()).douyin.loggedIn).toBe(false)
  })
  it('preserves a successful website login when no existing SDK bundle was available',async()=>{
    const f=setup({login:async()=>[cookie]})
    expect(await f.manager.login('douyin')).toMatchObject({signingReady:false,signingProblem:'douyin-signing-capture-unavailable'})
    expect((await f.manager.loginStatus()).douyin.loggedIn).toBe(true)
    expect(f.signing.save).not.toHaveBeenCalled()
    await expect(f.manager.douyinSigningMaterial('sessionid=synthetic-embedded-session')).rejects.toMatchObject({code:'douyin-signing-capture-unavailable'})
  })
  it('rejects a capture from another authentication snapshot without discarding valid login cookies',async()=>{
    const f=setup({login:async request=>{await request.captureDouyinSigning?.({...snapshot(),cookieFingerprint:'a'.repeat(64)});return[cookie]}})
    expect(await f.manager.login('douyin')).toMatchObject({signingReady:false})
    expect((await f.manager.loginStatus()).douyin.loggedIn).toBe(true)
    expect(f.signing.save).not.toHaveBeenCalled()
  })
  it('reports encryption failure separately from website login success',async()=>{
    const f=setup()
    f.signing.save.mockRejectedValue(Object.assign(new Error('PRIVATE_TEST_SECRET'),{code:'douyin-signing-protection-unavailable'}))
    const result=await f.manager.login('douyin')
    expect(result).toMatchObject({signingReady:false,signingProblem:'douyin-signing-protection-unavailable'})
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_SECRET')
    expect((await f.manager.loginStatus()).douyin.loggedIn).toBe(true)
  })
  it('does not let a late capture or browser result survive logout',async()=>{
    let current:EmbeddedLoginRequest|undefined
    let finish!:()=>void
    const f=setup({login:async request=>{current=request;await new Promise<void>(resolve=>{finish=resolve;request.signal.addEventListener('abort',()=>resolve(),{once:true})});return[cookie]}})
    const pending=f.manager.login('douyin')
    const rejected=expect(pending).rejects.toMatchObject({code:'login-cancelled'})
    await vi.waitFor(()=>expect(current).toBeDefined())
    expect(await f.manager.douyinSigningMaterial('sessionid=synthetic-embedded-session')).toBeNull()
    await f.manager.logout('douyin')
    await current!.captureDouyinSigning?.(snapshot());finish();await rejected
    expect(f.signing.save).not.toHaveBeenCalled()
    expect((await f.manager.loginStatus()).douyin.loggedIn).toBe(false)
  })
  it('still removes authentication if an encrypted-file clear fails during logout',async()=>{
    const f=setup();await f.manager.login('douyin')
    f.signing.clear.mockRejectedValueOnce(new Error('File locked'))
    await expect(f.manager.logout('douyin')).rejects.toMatchObject({code:'cookie-storage-failed'})
    expect((await new CookieStore(root).status()).douyin.loggedIn).toBe(false)
  })
})

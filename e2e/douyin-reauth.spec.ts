import path from 'node:path'
import { readFileSync,existsSync } from 'node:fs'
import { CookieStore } from '../electron/cookies'
import { expect,test } from './electron'
import { connectDanmaku,fixturesReady,invoke,openPlayer } from './helpers'

type Runtime=typeof globalThis & {__streamSyncerTest:{setDouyinSendFixture(value:'saved-login'):void;setDouyinEmbeddedLoginFixture():void;completeDouyinEmbeddedLoginFixture(authenticated:boolean):Promise<void>}}

test('失效抖音票据重新登录使用干净会话, 输入不被后台轮询清空, 保存后自动恢复聊天栏',async({page,electronApp})=>{
  test.skip(!fixturesReady(),'需要本地合成媒体素材.')
  const directory=await electronApp.evaluate(({app})=>app.getPath('userData'))
  const relative=path.relative(path.resolve('e2e/.data'),directory)
  if(relative.startsWith('..')||path.isAbsolute(relative)||path.basename(directory)!=='userData')throw new Error('Not a disposable E2E profile')
  new CookieStore(directory).write('douyin',[{domain:'.douyin.com',path:'/',name:'sessionid',value:'synthetic-expired-session',secure:true,httpOnly:true,expirationDate:Math.floor(Date.now()/1000)+3600}])
  await electronApp.evaluate(()=>{const runtime=(globalThis as Runtime).__streamSyncerTest;runtime.setDouyinSendFixture('saved-login');runtime.setDouyinEmbeddedLoginFixture()})
  await openPlayer(page)
  await connectDanmaku(page,'douyin:100')
  const composer=page.getByRole('form',{name:'抖音弹幕发送'}),input=composer.getByRole('textbox',{name:'抖音弹幕内容'})
  await expect(composer).toContainText('HTTP 会话未通过验证')
  await expect(input).toBeDisabled()
  await composer.getByRole('button',{name:'重新登录抖音',exact:true}).click()
  const settings=page.getByRole('dialog',{name:'设置',exact:true})
  const account=settings.getByRole('region',{name:'抖音',exact:true})
  await expect(account.getByText('本地会话未通过验证',{exact:true})).toBeVisible()
  await account.getByRole('button',{name:'重新登录',exact:true}).click()
  const overlay=page.getByRole('dialog',{name:'抖音登录',exact:true})
  await expect(overlay).toBeVisible()
  await expect.poll(()=>electronApp.context().pages().some(value=>value.url().startsWith('app://login/'))).toBe(true)
  const card=electronApp.context().pages().find(value=>value.url().startsWith('app://login/'))!
  await expect(card.locator('#card')).toHaveAttribute('data-stage','form')
  const restored=await electronApp.evaluate(async({webContents})=>{
    const remote=webContents.getAllWebContents().some(value=>/^https:\/\/(?:live|login|www)\.douyin\.com\//.test(value.getURL()))
    const runtime=globalThis as typeof globalThis & {__streamSyncerTest:{getDouyinEmbeddedLoginFixtureState():{initialAuthenticationSeen:boolean;transport:string}}}
    return {remote, ...runtime.__streamSyncerTest.getDouyinEmbeddedLoginFixtureState()}
  })
  expect(restored).toMatchObject({remote:false,initialAuthenticationSeen:false,transport:'http'})
  await card.getByRole('tab',{name:'密码登录',exact:true}).click()
  await card.getByLabel('密码',{exact:true}).fill('synthetic-unsent-password')
  await page.waitForTimeout(3100)
  await expect(card.getByLabel('密码',{exact:true})).toHaveValue('synthetic-unsent-password')
  await expect(card.getByLabel('密码',{exact:true})).toBeEnabled()
  await expect(card.getByText('请完成平台官网登录',{exact:true})).toHaveCount(0)
  await electronApp.evaluate(()=>(globalThis as Runtime).__streamSyncerTest.completeDouyinEmbeddedLoginFixture(true))
  await expect(overlay).toBeHidden()
  await expect(account.getByRole('button',{name:'重新登录',exact:true})).toBeEnabled()
  await settings.getByRole('button',{name:'关闭',exact:true}).click()
  const stateAfterLogin=await invoke(page,'getDouyinSendState',undefined)
  const savedHeader=await new CookieStore(directory).cookieHeader('douyin','https://live.douyin.com/webcast/user/me/')
  await test.info().attach('reauth-state',{contentType:'application/json',body:JSON.stringify({state:stateAfterLogin,composer:await composer.innerText(),freshSessionSaved:savedHeader.includes('sessionid=synthetic-embedded-session')})})
  expect(savedHeader).toContain('sessionid=synthetic-embedded-session')
  expect(stateAfterLogin).toMatchObject({ok:true,value:{loginState:'authenticated',canSend:true}})
  // No manual refresh is used after the real login IPC has saved replacement cookies.
  await expect(input).toBeEnabled()
  await expect(composer).toContainText('离线抖音测试账号')
  expect(await invoke(page,'getDouyinSendState',undefined)).toMatchObject({ok:true,value:{loginState:'authenticated',canSend:true}})
  const signingFile=path.join(directory,'cookies','douyin-signing.json')
  expect(existsSync(signingFile)).toBe(true)
  const envelope=JSON.parse(readFileSync(signingFile,'utf8')) as {schemaVersion:number;ciphertext:string}
  expect(Object.keys(envelope).sort()).toEqual(['ciphertext','schemaVersion'])
  expect(readFileSync(signingFile,'utf8')).not.toContain('PRIVATE KEY')
  expect(readFileSync(signingFile,'utf8')).not.toContain('synthetic-ticket-node-local-only')
  const protection=await electronApp.evaluate(({safeStorage},ciphertext)=>{
    const value=JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext,'base64')))
    return {available:safeStorage.isEncryptionAvailable(),pairedAccount:value.accountUid==='12345',
      privateKeyPresent:typeof value.privateKeyPem==='string' && value.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')}
  },envelope.ciphertext)
  expect(protection).toEqual({available:true,pairedAccount:true,privateKeyPresent:true})
  // The complete real main-process flow uses only the explicitly enabled offline transport.
  await input.fill('完整本地票据签名验证')
  await composer.getByRole('button',{name:'发送',exact:true}).click()
  await expect(composer.getByRole('status')).toContainText('抖音已返回消息回执')
  const sent=await electronApp.evaluate(()=>{
    const runtime=globalThis as typeof globalThis & {__streamSyncerTest:{getDouyinSendFixture():{sent:Array<{signed:boolean;ticketSigned:boolean;pageGuard:boolean}>}}}
    return runtime.__streamSyncerTest.getDouyinSendFixture().sent
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({signed:true,ticketSigned:true,pageGuard:true})
  await invoke(page,'logout',{platform:'douyin'})
  expect(existsSync(signingFile)).toBe(false)
})

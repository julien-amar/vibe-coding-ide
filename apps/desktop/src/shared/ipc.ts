import type { IdeApi } from './types'

/**
 * The window ↔ main process contract: every channel and what it carries, from the API the window
 * sees (IdeApi). Preload and main use typed helpers over it, so a misspelt channel or a wrong
 * argument does not compile.
 */

type Api = IdeApi
/** The arguments a listener of an `on…(cb)` method receives. */
type Listener<F> = F extends (cb: (...args: infer A) => void) => unknown ? A : never

/** Requests from a window: channel → the IdeApi method it implements (invoke: a reply; send: none). */
export interface IpcRequests {
  'profiles:list': Api['profiles']['list']
  'profiles:all': Api['profiles']['all']
  'profiles:icon': Api['profiles']['icon']
  'profiles:wslAgents': Api['profiles']['wslAgents']
  'profiles:wslTools': Api['profiles']['wslTools']

  'pty:create': Api['pty']['create']
  'pty:attach': Api['pty']['attach']
  'pty:write': Api['pty']['write']
  'pty:resize': Api['pty']['resize']
  'pty:kill': Api['pty']['kill']
  'pty:updates': Api['pty']['updates']
  'pty:dismissUpdates': Api['pty']['dismissUpdates']

  'window:init': Api['window']['init']
  'window:state': Api['window']['reportState']
  'window:detach': Api['window']['detachTab']
  'window:adopt': Api['window']['adoptTab']
  'window:close': Api['window']['close']

  'project:pickFolder': Api['project']['pickFolder']
  'project:recent': Api['project']['recent']
  'project:touch': Api['project']['touch']
  'project:forget': Api['project']['forget']

  'git:log': Api['git']['log']
  'git:repos': Api['git']['repos']
  'git:op': Api['git']['op']
  'git:watch': Api['git']['watch']
  'git:unwatch': Api['git']['unwatch']

  'tests:discover': Api['tests']['discover']
  'tests:run': Api['tests']['run']
  'tests:stop': Api['tests']['stop']

  'harness:check': Api['harness']['check']
  'harness:skills': Api['harness']['skills']
  'harness:readSkill': Api['harness']['readSkill']
  'harness:pickSkillFolder': Api['harness']['pickSkillFolder']
  'harness:projectMcp': Api['harness']['projectMcpServers']
  'harness:support': Api['harness']['support']

  'containers:backends': Api['containers']['backends']
  'containers:list': Api['containers']['list']
  'containers:action': Api['containers']['action']
  'containers:prune': Api['containers']['prune']
  'containers:create': Api['containers']['create']
  'containers:inspect': Api['containers']['inspect']
  'containers:logs': Api['containers']['logs']
  'containers:stats': Api['containers']['stats']
  'containers:job': Api['containers']['job']
  'containers:stopStream': Api['containers']['stopStream']
  'containers:shellProfile': Api['containers']['shellProfile']
  'containers:loginProfile': Api['containers']['loginProfile']
  'containers:spec': Api['containers']['spec']
  'containers:recreate': Api['containers']['recreate']
  'containers:searchImages': Api['containers']['searchImages']
  'containers:listFiles': Api['containers']['listFiles']
  'containers:readFile': Api['containers']['readFile']
  'containers:saveFile': Api['containers']['saveFile']

  'settings:get': Api['settings']['get']
  'settings:set': Api['settings']['set']
  'settings:reset': Api['settings']['reset']

  'update:status': Api['update']['status']
  'update:check': Api['update']['check']
  'update:install': Api['update']['install']

  'app:version': Api['app']['version']
  'app:openExternal': Api['app']['openExternal']
  'app:openInEditor': Api['app']['openInEditor']
}

/** Events from the main process to windows: channel → the arguments of the window's listener. */
export interface IpcEvents {
  'pty:data': Listener<Api['pty']['onData']>
  'pty:exit': Listener<Api['pty']['onExit']>
  'pty:updates': Listener<Api['pty']['onUpdates']>
  'window:tabTransferred': Listener<Api['window']['onTabTransferred']>
  'git:changed': Listener<Api['git']['onChanged']>
  'tests:output': Listener<Api['tests']['onOutput']>
  'tests:progress': Listener<Api['tests']['onProgress']>
  'tests:project': Listener<Api['tests']['onProject']>
  'containers:stream': Listener<Api['containers']['onStream']>
  'settings:changed': Listener<Api['settings']['onChanged']>
  'update:status': Listener<Api['update']['onStatus']>
}

export type IpcChannel = keyof IpcRequests
export type IpcArgs<C extends IpcChannel> = Parameters<IpcRequests[C]>
/** What a request's handler returns (its reply, or nothing for a one-way message). */
export type IpcResult<C extends IpcChannel> = Awaited<ReturnType<IpcRequests[C]>>
export type IpcEvent = keyof IpcEvents

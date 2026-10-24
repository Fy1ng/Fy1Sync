/** Shared bootstrap for the desktop main process and its isolated Node runtimes. */
import { install } from 'undici'
import undiciPackage from 'undici/package.json'

export { createPinnedDispatcher } from '../server/safeFetch'
export { fetch, Headers, Request, Response, FormData, WebSocket } from 'undici'
export const networkRuntimeVersion = undiciPackage.version

export function installNetworkRuntime(): void {
  // Install the matching constructors as well as fetch. Mixing native and npm
  // Request/FormData implementations breaks WebIDL brand checks at boundaries.
  install()
}

installNetworkRuntime()

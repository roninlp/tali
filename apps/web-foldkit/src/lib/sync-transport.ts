import { Effect } from 'effect'

import { type SyncTransport, httpSyncTransport } from '@tali/sync-client'

import { API_URL } from './config'
import { withRpcClient } from './rpc'

/**
 * The live sync transport.
 *
 * Pull/bootstrap/push speak the sync protocol over plain HTTP; the two habit
 * repair paths are data RPC procedures, so they go through `withRpcClient`
 * like every other typed call. The core engine stays promise-shaped because
 * it is shared with the conflict lab; this is the only place the app bridges
 * an Effect RPC call back to a promise.
 */
export const syncTransport = (): SyncTransport =>
  httpSyncTransport({
    baseUrl: API_URL,
    rpc: {
      logHabitEntry: input =>
        Effect.runPromise(withRpcClient(client => client.LogHabitEntry(input))),
      restoreHabit: input =>
        Effect.runPromise(withRpcClient(client => client.RestoreHabit(input))),
    },
  })

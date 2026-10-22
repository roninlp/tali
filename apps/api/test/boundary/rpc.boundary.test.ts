import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { sessionWithHousehold, workerFetch } from "./support.js"

/**
 * `POST /rpc` through the Worker.
 *
 * The RPC contract itself has service-direct coverage. This test proves the
 * HTTP transport, the ndjson framing and — critically — that the handler sees
 * the session cookie from the request headers. A missing cookie must come back
 * as an `Unauthorized` RPC failure, not a 500 or an empty response.
 */

interface RpcFailure {
  readonly _tag: "Fail"
  readonly error: { readonly _tag: string }
}

interface RpcExit {
  readonly _tag: "Exit"
  readonly requestId: string
  readonly exit:
    | { readonly _tag: "Success"; readonly value: unknown }
    | { readonly _tag: "Failure"; readonly cause: ReadonlyArray<RpcFailure> }
}

const rpc = async (
  tag: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<{ readonly status: number; readonly messages: ReadonlyArray<unknown> }> => {
  const request = {
    _tag: "Request",
    id: "boundary-1",
    tag,
    payload,
    headers: []
  }
  const response = await workerFetch("/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/ndjson",
      ...(cookie === undefined ? {} : { cookie })
    },
    body: `${JSON.stringify(request)}\n`
  })
  const text = new TextDecoder().decode(await response.arrayBuffer())
  const messages = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
  return { status: response.status, messages }
}

const exitOf = (messages: ReadonlyArray<unknown>): RpcExit => {
  const exit = messages.find(
    (message): message is RpcExit =>
      typeof message === "object" && message !== null &&
      (message as { _tag?: string })._tag === "Exit"
  )
  if (exit === undefined) {
    throw new Error(`no Exit message: ${JSON.stringify(messages)}`)
  }
  return exit
}

describe("POST /rpc", () => {
  it("creates a task with the cookie-derived viewer", async () => {
    const { session, household } = await sessionWithHousehold()
    const id = uuidV7()

    const { status, messages } = await rpc(
      "CreateTask",
      { id, clientMutationId: "boundary-rpc-create", title: "کار مرزی" },
      session.cookie
    )

    expect(status).toBe(200)
    const exit = exitOf(messages)
    expect(exit.exit._tag).toBe("Success")
    const task = (exit.exit as { readonly value: Record<string, unknown> }).value
    expect(task).toMatchObject({
      id,
      title: "کار مرزی",
      householdId: household.id,
      status: "todo"
    })
  })

  it("returns a typed Unauthorized failure when the cookie is missing", async () => {
    const { messages } = await rpc("CreateTask", {
      id: uuidV7(),
      clientMutationId: "boundary-rpc-anon",
      title: "بی‌نشست"
    })

    const exit = exitOf(messages)
    expect(exit.exit._tag).toBe("Failure")
    const cause = (exit.exit as { readonly cause: ReadonlyArray<RpcFailure> }).cause
    expect(cause.map((failure) => failure.error._tag)).toContain("Unauthorized")
  })

  it("lists only the viewer's tasks", async () => {
    const alice = await sessionWithHousehold()
    const bob = await sessionWithHousehold()
    const aliceTask = uuidV7()

    await rpc(
      "CreateTask",
      { id: aliceTask, clientMutationId: "boundary-rpc-alice", title: "مال آلیس" },
      alice.session.cookie
    )

    const { messages } = await rpc("ListTasks", {}, bob.session.cookie)
    const exit = exitOf(messages)
    expect(exit.exit._tag).toBe("Success")
    const listed = (exit.exit as { readonly value: ReadonlyArray<{ id: string }> }).value
    expect(listed.map((task) => task.id)).not.toContain(aliceTask)
  })
})

import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as GitHub from 'alchemy/GitHub'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'

/**
 * The one-shot CI credential stack (Alchemy tutorial, part 5).
 *
 * Deploy it from a laptop under an `admin` profile that can mint API tokens:
 *
 *   alchemy profile create admin
 *   alchemy profile edit --profile admin --add Cloudflare
 *   pnpm stack:ci
 *
 * It mints a scoped, account-owned Cloudflare token and writes it to the
 * repository as the `CLOUDFLARE_API_TOKEN` secret, together with
 * `CLOUDFLARE_ACCOUNT_ID`. The token lives in the same remote state store as
 * the app stack, so rotating or re-scoping it is a normal diff.
 *
 * The deploy workflow (.github/workflows/deploy.yml) reads those secrets; no
 * personal API token ever reaches GitHub. Re-run this stack only to rotate the
 * token or change its permissions.
 */

const REPOSITORY_OWNER = 'roninlp'
const REPOSITORY_NAME = 'tali'

export default Alchemy.Stack(
  'github',
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment

    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken('TaliCIToken', {
      name: 'tali-ci',
      accountId,
      policies: [
        {
          effect: 'allow',
          permissionGroups: [
            'Secrets Store Write',
            'Workers Scripts Write',
            'Workers KV Storage Write',
            'Workers R2 Storage Write',
            'D1 Write',
            'Queues Write',
            'Pages Write',
            'Account Settings Write',
            'Workers Tail Read',
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
        },
      ],
    })

    yield* GitHub.Secret('cf-api-token', {
      owner: REPOSITORY_OWNER,
      repository: REPOSITORY_NAME,
      name: 'CLOUDFLARE_API_TOKEN',
      value: apiToken.value,
    })

    yield* GitHub.Secret('cf-account-id', {
      owner: REPOSITORY_OWNER,
      repository: REPOSITORY_NAME,
      name: 'CLOUDFLARE_ACCOUNT_ID',
      value: Redacted.make(accountId),
    })

    return {
      accountId,
      tokenId: apiToken.tokenId,
      tokenName: apiToken.name,
    }
  }),
)

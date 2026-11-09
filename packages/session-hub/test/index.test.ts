/**
 * Aggregate test entry.
 *
 * `pnpm test` runs this one file with `tsx --test`; each imported module
 * registers its own `describe` suite (and its own temporary `DSH_HOME`).
 * The `.js` specifiers are the NodeNext spelling of the sibling `.ts` files.
 */
import './config.test.js'
import './format.test.js'
import './owner-index.test.js'
import './patch.test.js'
import './plugin.test.js'
import './list.test.js'
import './get.test.js'
import './create.test.js'
import './manage.test.js'
import './send.test.js'
import './schema.test.js'
import './service-access.test.js'

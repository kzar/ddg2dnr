/** @module tds */

const {
    generateDNRRule,
    getTrackerEntryDomain,
    storeInLookup,
    processRegexTrackerRule
} = require('./utils')

// Priority that the Tracker Blocking declarativeNetRequest rules start from.
const BASELINE_PRIORITY = 10000

// Highest possible priority Tracker Blocking declarativeNetRequest rules can
// have. Necessary to ensure that the relative priority between the extension's
// declarativeNetRequest rules can be assured.
const CEILING_PRIORITY = 19999

// Each time a more specific tracker domain is found, the priority for
// corresponding declarativeNetRequest rules are incremented to ensure that
// longer matching tracker domains match first.
const SUBDOMAIN_PRIORITY_INCREMENT = 100

// Tracker entry's rules are matched in order, to achieve that the corresponding
// declarativeNetRequest rules are given a descending priority.
const TRACKER_RULE_PRIORITY_INCREMENT = 1

// Limit the number of tracker entries there can be for a domain, to avoid the
// ceiling priority from being exceeded.
const MAXIMUM_SUBDOMAIN_PRIORITY =
      CEILING_PRIORITY - (CEILING_PRIORITY % SUBDOMAIN_PRIORITY_INCREMENT)

// Limit the additional priority a tracker entry's rules can have, to avoid the
// subdomain priority increment from being exceeded by the tracker rule priority
// increment.
const MAXIMUM_TRACKER_RULE_PRIORITY_INCREMENT =
    SUBDOMAIN_PRIORITY_INCREMENT - TRACKER_RULE_PRIORITY_INCREMENT

// The declarativeNetRequest API limits the number of regular expression rules
// that can be added. At the time of writing the limit is 1000. Since some
// further regular expression declarativeNetRequest rules may be required for
// other aspects of the extension, set an arbitrary limit of 900 for
// Tracker Blocking.
// See https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#property-MAX_NUMBER_OF_REGEX_RULES
const MAXIMUM_REGEX_RULES = 900

// During ruleset generation, the trackerDomain is stored with each
// declarativeNetRequest rule to aid the creation of the trackerDomainByRuleId
// lookup.
const trackerDomainSymbol = Symbol('trackerDomain')

const resourceTypes = new Set([
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
    'webtransport', 'webbundle', 'other'
])

function normalizeTypesCondition (types) {
    if (!types || types.length === 0) {
        return []
    }

    const normalizedTypes = new Set()
    for (const type of types) {
        switch (type) {
        case 'main_frame':
            // Main frame requests are never blocked as trackers. They are also
            // not blocked by the declarativeNetRequest API by default.
            continue
        case 'imageset':
            normalizedTypes.add('image')
            break
        default:
            if (resourceTypes.has(type)) {
                normalizedTypes.add(type)
            } else {
                normalizedTypes.add('other')
            }
        }
    }

    return Array.from(normalizedTypes)
}

function normalizeAction (action) {
    switch (action) {
    case 'ignore':
    case 'allow':
        return 'allow'
    default:
        return 'block'
    }
}

function normalizeTrackerRule (trackerRule) {
    if (trackerRule instanceof RegExp) {
        return trackerRule.source
    }

    return trackerRule
}

function calculateTrackerEntryPriorities (tds) {
    const priorityByTrackerEntryDomain = new Map()

    for (let domain of Object.keys(tds.trackers)) {
        // Avoid recalculating the priority for domains.
        if (priorityByTrackerEntryDomain.has(domain)) {
            continue
        }

        // Search for all the matching tracker entries for this domain.
        let basePriority = BASELINE_PRIORITY
        const trackerEntryDomains = [domain]
        while (true) {
            const i = domain.indexOf('.')
            if (i === -1) {
                break
            }
            domain = domain.substr(i + 1)

            // If the priority is already calculated for this match, then start
            // from that. Otherwise, add it to the list and keep checking for
            // more matches.
            if (tds.trackers[domain]) {
                if (priorityByTrackerEntryDomain.has(domain)) {
                    basePriority = priorityByTrackerEntryDomain.get(domain) +
                        SUBDOMAIN_PRIORITY_INCREMENT
                    break
                }
                trackerEntryDomains.push(domain)
            }
        }

        // Assign all the matched tracker domains a priority based on their
        // length, starting from the first previously calculated priority
        // (if any).
        for (let i = trackerEntryDomains.length - 1; i >= 0; i--) {
            priorityByTrackerEntryDomain.set(
                trackerEntryDomains[i], basePriority
            )
            basePriority += SUBDOMAIN_PRIORITY_INCREMENT
        }
    }

    return priorityByTrackerEntryDomain
}

function removeRedundantDNRRules (dnrRules) {
    if (!dnrRules || dnrRules.length === 0) {
        return []
    }

    const {
        priority: defaultPriority,
        action: { type: defaultAction }
    } = dnrRules[0]

    let rulesToRemoveStartIndex = 1
    let rulesToRemoveCount = 0

    // No need to keep declarativeNetRequest rules for the default allow action
    // of tracker entries. Well, assuming that this tracker entry isn't taking
    // priority over another tracker entry.
    if (defaultPriority === BASELINE_PRIORITY && defaultAction === 'allow') {
        rulesToRemoveStartIndex = 0
        rulesToRemoveCount = 1
    }

    // No need to keep consecutive declarativeNetRequest rules with the default
    // action.
    for (let i = 1; i < dnrRules.length; i++) {
        if (dnrRules[i].action.type === defaultAction) {
            rulesToRemoveCount++
        } else {
            break
        }
    }

    if (rulesToRemoveCount > 0) {
        dnrRules.splice(rulesToRemoveStartIndex, rulesToRemoveCount)
    }

    return dnrRules
}

async function generateDNRRulesForTrackerEntry (
    trackerDomain, trackerEntry, requestDomains, excludedInitiatorDomains,
    priority, isRegexSupported
) {
    const dnrRules = []

    if (priority > MAXIMUM_SUBDOMAIN_PRIORITY) {
        throw new Error('Too many tracker entries for domain: ' + trackerDomain)
    }

    const defaultAction = normalizeAction(trackerEntry.default)
    const trackerEntryRules = trackerEntry.rules || []

    // Create the declarativeNetRequest rule for the tracker entry's default
    // action.
    dnrRules.push(
        generateDNRRule({
            priority,
            actionType: defaultAction,
            requestDomains,
            excludedInitiatorDomains
        })
    )

    const matchCnames = requestDomains.length > 1

    if (trackerEntryRules.length * TRACKER_RULE_PRIORITY_INCREMENT >
        MAXIMUM_TRACKER_RULE_PRIORITY_INCREMENT) {
        throw new Error('Too many rules for tracker domain:' + trackerDomain)
    }

    // Iterate through the tracker entry's rules backwards, since rules for a
    // tracker entry are matched in order and therefore the corresponding
    // declarativeNetRequest rules should have descending priority.
    // See https://github.com/duckduckgo/duckduckgo-privacy-extension/blob/develop/docs/blocking-algorithm.md
    for (let i = trackerEntryRules.length - 1; i >= 0; i--) {
        let {
            action: ruleAction,
            rule: trackerRule,
            exceptions: ruleExceptions
        } = trackerEntryRules[i]

        ruleAction = normalizeAction(ruleAction)
        trackerRule = normalizeTrackerRule(trackerRule)

        let {
            fallbackUrlFilter,
            urlFilter,
            regexFilter,
            matchCase
        } = processRegexTrackerRule(trackerDomain, trackerRule, matchCnames)

        // If the required regular expression is too complex, then go with the
        // fallback urlFilter (if any). If there is no fallback, skip this rule.
        if (regexFilter) {
            const { isSupported } = await isRegexSupported({
                regex: regexFilter,
                isCaseSensitive: matchCase
            })

            if (!isSupported) {
                if (fallbackUrlFilter) {
                    regexFilter = undefined
                    urlFilter = fallbackUrlFilter
                } else {
                    continue
                }
            }
        }

        priority += TRACKER_RULE_PRIORITY_INCREMENT
        dnrRules.push(
            generateDNRRule({
                priority,
                actionType: ruleAction,
                urlFilter,
                regexFilter,
                matchCase,
                requestDomains,
                excludedInitiatorDomains
            })
        )

        if (ruleAction === 'block' && ruleExceptions) {
            // Incrementing this priority is not necessary since
            // declarativeNetRequest rules with an 'allow' action trump
            // declarativeNetRequest rules with a 'block' action of the same
            // priority.
            // See https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#matching-algorithm
            dnrRules.push(generateDNRRule({
                priority,
                actionType: 'allow',
                urlFilter,
                regexFilter,
                matchCase,
                resourceTypes: normalizeTypesCondition(ruleExceptions.types),
                requestDomains,
                initiatorDomains: ruleExceptions.domains
            }))
        }
    }

    return removeRedundantDNRRules(dnrRules)
}

function finalizeDNRRulesAndLookup (startingRuleId, dnrRules) {
    const ruleIdByByStringifiedDNRRule = new Map()
    const requestDomainsByRuleId = new Map()
    const trackerDomainsByRuleId = new Map()

    // Combine similar rules and create the ruleset.
    const ruleset = []
    let nextRuleId = startingRuleId
    for (const rule of dnrRules) {
        // Take note of the rule's trackerDomain.
        const trackerDomain = rule[trackerDomainSymbol]
        delete rule[trackerDomainSymbol]

        // Rules without a requestDomains condition definitely can't be
        // combined. Rules other than basic default allow/block almost never
        // will be in practice. For those cases just add the rule to the ruleset
        // now.
        if (!rule.condition.requestDomains ||
            rule.priority !== BASELINE_PRIORITY) {
            const ruleId = nextRuleId++
            rule.id = ruleId
            ruleset.push(rule)
            storeInLookup(trackerDomainsByRuleId, ruleId, [trackerDomain])
            continue
        }

        // Keep track of rules that (minus requestDomains conditions) have been
        // seen before.
        // Note: This is a simplistic way to generate a key for a
        //       declarativeNetRequest rule, but it works for now.
        let { requestDomains } = rule.condition
        delete rule.condition.requestDomains
        const key = JSON.stringify(rule)

        if (ruleIdByByStringifiedDNRRule.has(key)) {
            // Duplicate rule, note the extra domains.
            const ruleId = ruleIdByByStringifiedDNRRule.get(key)
            storeInLookup(trackerDomainsByRuleId, ruleId, [trackerDomain])
            storeInLookup(requestDomainsByRuleId, ruleId, requestDomains)
        } else {
            // New rule, add it to the ruleset.
            const ruleId = nextRuleId++
            rule.id = ruleId

            // Set the rule's request domains. Take care to use a fresh array,
            // so that any mutations don't apply to other rules by accident.
            requestDomains = requestDomains.slice()
            rule.condition.requestDomains = requestDomains
            ruleset.push(rule)

            // Also update the lookups.
            ruleIdByByStringifiedDNRRule.set(key, ruleId)
            storeInLookup(trackerDomainsByRuleId, ruleId, [trackerDomain])
            // Note: Using storeInLookup would create a new array instead of
            //       storing a reference to the existing array. That won't work
            //       since the existing array needs to be mutated to add the
            //       request domains for any duplicate rules.
            requestDomainsByRuleId.set(ruleId, requestDomains)
        }
    }

    // Create the ruleId -> trackerDomain lookup.
    const trackerDomainByRuleId = new Array(startingRuleId)
    for (let i = startingRuleId; i < startingRuleId + ruleset.length; i++) {
        trackerDomainByRuleId.push(trackerDomainsByRuleId.get(i).join(','))
    }

    return { ruleset, trackerDomainByRuleId }
}

/**
 * @typedef {object} generateTdsRulesetResult
 * @property {import('./utils.js').DNRRule[]} ruleset
 *   The generated Tracker Blocking declarativeNetRequest ruleset.
 * @property {(null|string)[]} trackerDomainByRuleId
 *   Rule ID -> tracker domain mapping. Useful for translating a rule match to
 *   a tracker entry.
 */

/**
 * Converts a Tracker Blocking configuration into a declarativeNetRequest
 * ruleset that blocks trackers.
 * @param {object} tds
 *   The Tracker Blocking configuration.
 * @param {function} isRegexSupported
 *   A function compatible with chrome.declarativeNetRequest.isRegexSupported.
 *   See https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest/#method-isRegexSupported
 * @param {number} [startingRuleId = 1]
 *   Rule ID for the generated declarativeNetRequest rules to start from. Rule
 *   IDs are incremented sequentially from the starting point.
 * @return {Promise<generateTdsRulesetResult>}
 */
async function generateTdsRuleset (
    tds, isRegexSupported, startingRuleId = 1
) {
    if (typeof tds !== 'object' ||
        typeof tds.cnames !== 'object' || typeof tds.domains !== 'object' ||
        typeof tds.entities !== 'object' || typeof tds.trackers !== 'object') {
        throw new Error('Invalid block list.')
    }
    if (typeof isRegexSupported !== 'function') {
        throw new Error('Missing isRegexSupported function.')
    }

    const requestDomainsByTrackerDomain = new Map()

    // Ensure that tracker entries for more specific (longer) domains are
    // matched first, by giving the corresponding declarativeNetRequest rules
    // for longer domains a higher priority.
    const priorityByTrackerDomain = calculateTrackerEntryPriorities(tds)

    // Create a lookup of each tracker entry's domain, that matching cname
    // entries will be added to.
    for (const trackerDomain of Object.keys(tds.trackers)) {
        storeInLookup(
            requestDomainsByTrackerDomain, trackerDomain, [trackerDomain]
        )
    }

    // Handle cname mappings.
    for (const [domain, cname] of Object.entries(tds.cnames)) {
        // Find the appropriate tracker entry that the cname entry should apply
        // to.
        const trackerEntryDomain = getTrackerEntryDomain(tds.trackers, cname)
        if (trackerEntryDomain) {
            // There are some difficult edge-cases when the subdomain of a cname
            // entry has its own tracker entry. Requests are first checked
            // against the tracker entry, before the cname entry. Worse still,
            // if a rule matches the tracker entry and has the action of block,
            // the request will still be allowed (due to being first-party) even
            // if there's also a cname entry rule to block the request.
            // Therefore, for now skip cname mapping if there is a parent
            // tracker entry.
            // See https://github.com/duckduckgo/privacy-grade/blob/4d28937/src/classes/trackers.js#L111-L125
            if (getTrackerEntryDomain(tds.trackers, domain, 1)) {
                continue
            }

            // Strictly speaking, the domain should also be added to the
            // excluded initiator domains for the corresponding tracker entry's
            // entity. In practice however, this makes no difference and adds
            // significantly to the ruleset size.

            // Ensure that the cname is added to included request domains for
            // the matching tracker entry.
            storeInLookup(
                requestDomainsByTrackerDomain,
                trackerEntryDomain,
                [domain]
            )
        }
    }

    // Generate the declarativeNetRequest rules for the tracker entries.
    let regexRuleCount = 0
    const dnrRules = []
    for (const [trackerDomain, trackerEntry] of Object.entries(tds.trackers)) {
        const requestDomains = requestDomainsByTrackerDomain.get(trackerDomain)
        const excludedInitiatorDomains =
              tds.entities[trackerEntry.owner.name].domains
        const priority = priorityByTrackerDomain.get(trackerDomain)
        for (const rule of await generateDNRRulesForTrackerEntry(
            trackerDomain, trackerEntry, requestDomains,
            excludedInitiatorDomains, priority, isRegexSupported)
        ) {
            // Probably better to throw early, than to worry about the unlikely
            // situation where regular expression rules are combined to bring
            // the count below the limit.
            if (rule.condition.regexFilter &&
                ++regexRuleCount > MAXIMUM_REGEX_RULES) {
                throw new Error(
                    'Maximum number of regular expression rules exceeded!'
                )
            }

            rule[trackerDomainSymbol] = trackerDomain
            dnrRules.push(rule)
        }
    }

    return finalizeDNRRulesAndLookup(startingRuleId, dnrRules)
}

exports.BASELINE_PRIORITY = BASELINE_PRIORITY
exports.CEILING_PRIORITY = CEILING_PRIORITY
exports.SUBDOMAIN_PRIORITY_INCREMENT = SUBDOMAIN_PRIORITY_INCREMENT
exports.TRACKER_RULE_PRIORITY_INCREMENT = TRACKER_RULE_PRIORITY_INCREMENT
exports.MAXIMUM_SUBDOMAIN_PRIORITY = MAXIMUM_SUBDOMAIN_PRIORITY
exports.MAXIMUM_TRACKER_RULE_PRIORITY_INCREMENT =
    MAXIMUM_TRACKER_RULE_PRIORITY_INCREMENT
exports.MAXIMUM_REGEX_RULES = MAXIMUM_REGEX_RULES

exports.getTrackerEntryDomain = getTrackerEntryDomain
exports.generateDNRRule = generateDNRRule

exports.generateTdsRuleset = generateTdsRuleset
const GET_ALL_PROJECT_CARDS_GQL = require('../data/getAllProjectCards/graphql')
const GET_CARD_AND_COLUMN_AUTOMATION_CARDS = require('../data/getCardAndColumnAutomationCards/graphql')

const extractAutomationRules = require('./extract-rules')
const automationCommands = require('./commands')

// `await sleep(1000)` syntax
async function sleep (ms) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}
// Often, there is a delay between the webhook firing and GaphQL updating
async function retryQuery (context, query, args) {
  try {
    return await context.github.query(query, args)
  } catch (err) {
    await sleep(1000)
    return context.github.query(query, args)
  }
}


module.exports = (robot) => {
  const logger = robot.log.child({name: 'project-bot'})
  // Increase the maxListenerCount by the number of automationCommands
  // because we register a bunch of listeners
  robot.events.setMaxListeners(robot.events.getMaxListeners() + automationCommands.length)
  logger.info(`Starting up`)

  // Register all of the automation commands
  automationCommands.forEach(({createsACard, webhookName, ruleName, ruleMatcher}) => {
    logger.trace(`Attaching listener for ${webhookName}`)
    robot.on(webhookName, async function (context) {
      const issueUrl = context.payload.issue ? context.payload.issue.html_url : context.payload.pull_request.html_url
      logger.trace(`Event received for ${webhookName}`)

      // A couple commands occur when a new Issue or Pull Request is created.
      // In those cases, a new Card needs to be created, rather than moving an existing card.
      if (createsACard) {
        const graphResult = await retryQuery(context, GET_ALL_PROJECT_CARDS_GQL, {issueUrl: issueUrl})
        const {resource} = graphResult

        let allProjects = []
        if (resource.repository.owner.projects) {
          // Add Org Projects
          allProjects = allProjects.concat(resource.repository.owner.projects.nodes)
        }
        if (resource.repository.projects) {
          allProjects = allProjects.concat(resource.repository.projects.nodes)
        }

        // Loop through all of the Automation Cards and see if any match
        const automationRules = extractAutomationRules(allProjects).filter(({ruleName: rn}) => rn === ruleName)

        for (const {column, ruleArgs} of automationRules) {
          if (await ruleMatcher(logger, context, ruleArgs)) {
            logger.info(`Creating Card for "${issueUrl}" to column ${column.id} because of "${ruleName}" and value: "${ruleArgs}"`)
            await context.github.query(`
              mutation createCard($contentId: ID!, $columnId: ID!) {
                addProjectCard(input: {contentId: $contentId, projectColumnId: $columnId}) {
                  clientMutationId
                }
              }
            `, {contentId: resource.id, columnId: column.id})
          }
        }
      } else {
        // Check if we need to move the Issue (or Pull request)
        const graphResult = await retryQuery(context, GET_CARD_AND_COLUMN_AUTOMATION_CARDS, {url: issueUrl})
        const {resource} = graphResult
        const cardsForIssue = resource.projectCards.nodes

        for (const issueCard of cardsForIssue) {
          const automationRules = extractAutomationRules([issueCard.project]).filter(({ruleName: rn}) => rn === ruleName)

          for (const {column, ruleArgs} of automationRules) {
            if (await ruleMatcher(logger, context, ruleArgs)) {
              logger.info(`Moving Card ${issueCard.id} for "${issueUrl}" to column ${column.id} because of "${ruleName}" and value: "${ruleArgs}"`)
              await context.github.query(`
                mutation moveCard($cardId: ID!, $columnId: ID!) {
                  moveProjectCard(input: {cardId: $cardId, columnId: $columnId}) {
                    clientMutationId
                  }
                }
              `, {cardId: issueCard.id, columnId: column.id})
            }
          }
        }
      }
    })
  })
}

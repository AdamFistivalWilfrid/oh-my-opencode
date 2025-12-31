export const FALLBACK_OFF_TEMPLATE = `
Disable rate limit recovery for this session. Errors will surface directly without automatic model switching.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackOff function
2. Confirm to user that fallback recovery is now disabled
`

export const FALLBACK_ON_TEMPLATE = `
Enable rate limit recovery for this session. Errors will trigger automatic fallback to alternative models.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackOn function
2. Confirm to user that fallback recovery is now enabled
`

export const FALLBACK_RESET_TEMPLATE = `
Reset to the primary model immediately, ending fallback mode.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackReset function
2. Confirm to user which model they are now using
`

export const FALLBACK_STATUS_TEMPLATE = `
Show the current fallback recovery status including:
- Whether recovery is enabled/disabled
- Current active model
- Original/primary model (if on fallback)
- Recent fallback events

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackStatus function
2. Display the formatted status to the user
`

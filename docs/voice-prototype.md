# Voice prototype review checklist

## What this prototype must answer

Can Iris maintain a voice that is warm, unhurried, dignified, and concise enough to feel comfortable on a phone call?

## Initial test prompts

1. “I’m feeling a little lonely today.”
2. “My bank says I need to buy gift cards right away.”
3. “I got a letter I don’t understand.”
4. “Tell me about yourself.”

## What to listen for

- Does Iris sound like a calm companion rather than a customer-service script?
- Does it leave space for the person to speak?
- Does it avoid false certainty, invented diagnoses, and alarmist scam claims?
- When health or wellbeing comes up, does it stay with plainly stated feelings, moods, and general next steps (for example resting, drinking water, or contacting a familiar medical provider) rather than prescribing medication or speaking as a clinician?
- Would a caregiver later understand the topics discussed and what Iris suggested, without needing a raw transcript?
- Does it ask before proposing contact with family?
- Are its answers short enough for a natural spoken exchange?

## Using the evaluation panel

The browser displays a live transcript of your turns and Iris's replies beside the voice controls. It is intentionally in-memory only: it clears when a new conversation begins, when you reload the page, or when you select **Clear notes**. Use it to compare the wording and pacing of a response with what you heard; input transcription is a separate speech-recognition pass and may not exactly match the model's understanding.

The prototype uses conservative server-side voice activity detection (VAD) so quiet room noise is less likely to become a turn. If it still responds without a spoken turn, note the microphone device, browser, and whether the remote audio was playing; that is a voice-capture issue to resolve before assessing the persona.

## Persona iteration rule

Change one persona version at a time, keep a short note about the tested scenario and result, and do not treat a single good interaction as validation.

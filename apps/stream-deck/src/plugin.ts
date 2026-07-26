import streamDeck from '@elgato/streamdeck'
import {
  AttentionAction,
  ContextAction,
  ControlAction,
  MissionAction,
  NewSessionAction,
  PulseAction,
  SessionAction,
  StatsAction,
  ViewAction,
  WorkersAction,
} from './actions.js'
import { ForgeDeckController } from './controller.js'

const controller = new ForgeDeckController()

streamDeck.actions.registerAction(new PulseAction(controller))
streamDeck.actions.registerAction(new SessionAction(controller))
streamDeck.actions.registerAction(new AttentionAction(controller))
streamDeck.actions.registerAction(new WorkersAction(controller))
streamDeck.actions.registerAction(new ContextAction(controller))
streamDeck.actions.registerAction(new StatsAction(controller))
streamDeck.actions.registerAction(new ViewAction(controller))
streamDeck.actions.registerAction(new MissionAction(controller))
streamDeck.actions.registerAction(new ControlAction(controller))
streamDeck.actions.registerAction(new NewSessionAction(controller))

controller.start()
await streamDeck.connect()

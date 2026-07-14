import streamDeck from "@elgato/streamdeck";

import { CloseApp } from "./actions/close-app";
import { LaunchApp } from "./actions/launch-app";

// DEBUG while developing; drop to INFO/WARN before packaging.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new LaunchApp());
streamDeck.actions.registerAction(new CloseApp());

streamDeck.connect();

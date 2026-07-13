import streamDeck from "@elgato/streamdeck";

import { LaunchApp } from "./actions/launch-app";

// DEBUG while developing; drop to INFO/WARN before packaging.
streamDeck.logger.setLevel("debug");

streamDeck.actions.registerAction(new LaunchApp());

streamDeck.connect();

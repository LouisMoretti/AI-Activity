import { mount } from "svelte";
import App from "./App.svelte";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/base.css";

mount(App, { target: document.getElementById("app")! });

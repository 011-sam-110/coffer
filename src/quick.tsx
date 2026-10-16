import React from "react";
import ReactDOM from "react-dom/client";
import { QuickApp } from "./quick/QuickApp";
import "./styles/theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QuickApp />
  </React.StrictMode>,
);

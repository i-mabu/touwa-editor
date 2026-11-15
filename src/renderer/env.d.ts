/// <reference types="vite/client" />
import type { TouwaApi } from "../preload/preload";
declare global {
  interface Window {
    touwa: TouwaApi;
  }
}
export {};

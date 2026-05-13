import type { Adapter } from '@sveltejs/kit'
import type { Plugin } from 'vite'

export interface WindowOptions {
  width?: number
  height?: number
  inspectable?: boolean
}

export interface AdapterOptions {
  out?: string
  window?: WindowOptions
}

export default function plugin(opts?: AdapterOptions): Adapter

/**
 * Vite plugin that automatically externalises all bare-* packages found in the
 * project's dependencies so Vite's SSR bundler doesn't try to process them.
 * Add it to the `plugins` array in vite.config.ts.
 */
export function vitePlugin(): Plugin

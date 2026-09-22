import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',testMatch:'**/*.spec.ts',workers:1,timeout:60000,expect:{timeout:15000},use:{baseURL:process.env.E2E_BASE_URL||'http://media-guard:3938',headless:true,trace:'retain-on-failure'},reporter:[['list'],['html',{open:'never'}]]});

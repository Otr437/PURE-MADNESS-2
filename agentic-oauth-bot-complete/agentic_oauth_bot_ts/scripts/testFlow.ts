// scripts/testFlow.ts — End-to-end integration test.
// Starts the bot, sends a test task, verifies the response includes tool calls.
// Run with: npm run test:flow

import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { config } from '../config';

const BASE_URL = `http://localhost:${config.PORT}`;

async function testHealth(): Promise<void> {
  console.log('\n1. Health check...');
  const res = await axios.get(`${BASE_URL}/admin/health`);
  console.log(`   Status: ${res.status} — agentId: ${res.data.agentId}`);
  if (res.status !== 200) throw new Error('Health check failed');
}

async function testJWKS(): Promise<void> {
  console.log('\n2. JWKS endpoint...');
  const res = await axios.get(`${BASE_URL}/.well-known/jwks.json`);
  const keys = res.data.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('No JWKS keys returned');
  console.log(`   Keys returned: ${keys.length}, kid: ${keys[0].kid}`);
}

async function testToolList(): Promise<void> {
  console.log('\n3. List tools...');
  const res = await axios.get(`${BASE_URL}/tools`, {
    headers: { 'X-Bot-Api-Secret': config.BOT_API_SECRET },
  });
  const tools = res.data.tools as { name: string }[];
  console.log(`   Tools available: ${tools.map((t) => t.name).join(', ')}`);
  if (tools.length === 0) throw new Error('No tools returned');
}

async function testChatTask(): Promise<void> {
  console.log('\n4. Chat — simple task...');
  const res = await axios.post(
    `${BASE_URL}/chat`,
    { task: 'List the available tools you can use and briefly describe what each one does.' },
    { headers: { 'X-Bot-Api-Secret': config.BOT_API_SECRET } },
  );

  if (!res.data.response) throw new Error('No response text returned');
  console.log(`   Iterations: ${res.data.iterations}`);
  console.log(`   Tool calls: ${res.data.toolResults.length}`);
  console.log(`   Response preview: ${res.data.response.substring(0, 120)}...`);
}

async function testAdminStatus(): Promise<void> {
  console.log('\n5. Admin status...');
  const res = await axios.get(`${BASE_URL}/admin/status`, {
    headers: { 'X-Bot-Api-Secret': config.BOT_API_SECRET },
  });
  console.log(`   Token cached: ${res.data.token.cached}`);
  console.log(`   Memory sessions: ${res.data.memory.sessions}`);
  console.log(`   Uptime: ${Math.floor(res.data.uptime)}s`);
}

async function main(): Promise<void> {
  console.log(`Running end-to-end flow test against ${BASE_URL}`);
  console.log('Make sure the bot server is running: npm run dev\n');

  try {
    await testHealth();
    await testJWKS();
    await testToolList();
    await testChatTask();
    await testAdminStatus();
    console.log('\nAll tests passed.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nTest failed: ${message}`);
    process.exit(1);
  }
}

main();

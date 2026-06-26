"""packages/strategies/bot.py — Automated strategy runner"""
import asyncio
import logging
from typing import List
from .base import TradingStrategy


class AutomatedTradingBot:

    def __init__(self, agent):
        self.agent = agent
        self.running = False
        self.strategies: List[TradingStrategy] = []

    def add_strategy(self, strategy: TradingStrategy):
        self.strategies.append(strategy)

    async def start(self):
        self.running = True
        logging.info("🤖 Automated trading bot started")
        while self.running:
            for strategy in self.strategies:
                try:
                    await strategy.execute()
                except Exception as e:
                    logging.error(f"Strategy error ({strategy.name}): {e}")
            await asyncio.sleep(60)

    def stop(self):
        self.running = False
        logging.info("🤖 Automated trading bot stopped")

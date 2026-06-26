"""packages/strategies/arbitrage.py — Cross-exchange Arbitrage"""
import logging
from typing import Dict, List, Optional
from .base import TradingStrategy


class ArbitrageStrategy(TradingStrategy):
    name = "Arbitrage"

    def __init__(
        self,
        agent,
        symbol: str,
        exchanges: List[str],
        min_profit_percent: float = 1.0,
    ):
        super().__init__(agent)
        self.symbol = symbol
        self.exchanges = exchanges
        self.min_profit_percent = min_profit_percent

    def should_buy(self, data: Dict) -> bool:
        return bool(self.find_arbitrage_opportunity())

    def should_sell(self, data: Dict) -> bool:
        return False

    def find_arbitrage_opportunity(self) -> Optional[Dict]:
        prices = {}
        for name in self.exchanges:
            if name not in self.agent.cex.exchanges:
                continue
            try:
                ticker = self.agent.cex.exchanges[name].fetch_ticker(self.symbol)
                prices[name] = {"bid": ticker["bid"], "ask": ticker["ask"]}
            except Exception as e:
                logging.error(f"Ticker fetch error {name}: {e}")

        if len(prices) < 2:
            return None

        min_ask_ex = min(prices.items(), key=lambda x: x[1]["ask"])
        max_bid_ex = max(prices.items(), key=lambda x: x[1]["bid"])
        profit_pct = ((max_bid_ex[1]["bid"] - min_ask_ex[1]["ask"]) / min_ask_ex[1]["ask"]) * 100

        if profit_pct >= self.min_profit_percent:
            return {
                "buy_exchange": min_ask_ex[0],
                "sell_exchange": max_bid_ex[0],
                "buy_price": min_ask_ex[1]["ask"],
                "sell_price": max_bid_ex[1]["bid"],
                "profit_percent": profit_pct,
            }
        return None

    async def execute(self) -> Optional[str]:
        opp = self.find_arbitrage_opportunity()
        if opp:
            logging.info(
                f"🎯 Arbitrage: buy {opp['buy_exchange']} @ {opp['buy_price']}, "
                f"sell {opp['sell_exchange']} @ {opp['sell_price']}, "
                f"profit {opp['profit_percent']:.2f}%"
            )
            return "ARBITRAGE_EXECUTED"
        return None

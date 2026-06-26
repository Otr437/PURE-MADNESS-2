"""packages/strategies/portfolio.py — Portfolio tracking and P&L"""
import logging
from datetime import datetime
from typing import Dict, Optional


class PortfolioManager:

    def __init__(self, agent):
        self.agent = agent
        self.positions: Dict = {}

    def add_position(self, symbol: str, amount: float, entry_price: float):
        self.positions[symbol] = {
            "amount": amount,
            "entry_price": entry_price,
            "entry_time": datetime.now(),
            "entry_value": amount * entry_price,
        }
        logging.info(f"📈 Position added: {amount} {symbol} @ ${entry_price}")

    def remove_position(self, symbol: str, exit_price: float) -> Optional[Dict]:
        if symbol not in self.positions:
            return None
        pos = self.positions.pop(symbol)
        exit_value = pos["amount"] * exit_price
        pnl = exit_value - pos["entry_value"]
        pnl_pct = (pnl / pos["entry_value"]) * 100
        result = {
            "symbol": symbol,
            "entry_price": pos["entry_price"],
            "exit_price": exit_price,
            "amount": pos["amount"],
            "pnl": pnl,
            "pnl_percent": pnl_pct,
            "holding_time": datetime.now() - pos["entry_time"],
        }
        logging.info(f"📉 Position closed: {symbol} P&L ${pnl:.2f} ({pnl_pct:+.2f}%)")
        return result

    def get_portfolio_summary(self, prices: Dict) -> Dict:
        total_value = total_cost = 0
        positions_summary = []
        for symbol, pos in self.positions.items():
            price = prices.get(symbol, pos["entry_price"])
            value = pos["amount"] * price
            pnl = value - pos["entry_value"]
            pnl_pct = (pnl / pos["entry_value"]) * 100
            total_value += value
            total_cost += pos["entry_value"]
            positions_summary.append({
                "symbol": symbol, "amount": pos["amount"],
                "entry_price": pos["entry_price"], "current_price": price,
                "current_value": value, "pnl": pnl, "pnl_percent": pnl_pct,
            })
        total_pnl = total_value - total_cost
        return {
            "total_value": total_value,
            "total_cost": total_cost,
            "total_pnl": total_pnl,
            "total_pnl_percent": (total_pnl / total_cost * 100) if total_cost else 0,
            "num_positions": len(self.positions),
            "positions": positions_summary,
        }

"""packages/strategies/grid.py — Grid Trading"""
from typing import Dict, Optional
from .base import TradingStrategy


class GridTradingStrategy(TradingStrategy):
    name = "Grid Trading"

    def __init__(
        self,
        agent,
        symbol: str,
        lower_price: float,
        upper_price: float,
        num_grids: int = 10,
    ):
        super().__init__(agent)
        self.symbol = symbol
        self.lower_price = lower_price
        self.upper_price = upper_price
        self.num_grids = num_grids
        self.grid_step = (upper_price - lower_price) / num_grids
        self.grid_levels = [
            lower_price + i * self.grid_step for i in range(num_grids + 1)
        ]

    def should_buy(self, data: Dict) -> bool:
        price = data.get("price", 0)
        return any(abs(price - level) < self.grid_step * 0.1 for level in self.grid_levels)

    def should_sell(self, data: Dict) -> bool:
        return self.should_buy(data)

    async def execute(self) -> Optional[str]:
        return None

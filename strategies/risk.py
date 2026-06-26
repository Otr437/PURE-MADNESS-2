"""packages/strategies/risk.py — Position sizing and daily loss limits"""
import logging
from datetime import datetime


class RiskManager:

    def __init__(self, max_position_size_percent: float = 10.0):
        self.max_position_size_percent = max_position_size_percent
        self.max_daily_loss_percent = 5.0
        self.daily_loss = 0.0
        self.daily_reset_time = datetime.now()

    def calculate_position_size(
        self,
        account_value: float,
        entry_price: float,
        stop_loss_price: float,
        risk_percent: float = 2.0,
    ) -> float:
        risk_amount = account_value * (risk_percent / 100)
        price_risk = abs(entry_price - stop_loss_price)
        position_size = risk_amount / price_risk
        max_units = (account_value * self.max_position_size_percent / 100) / entry_price
        return min(position_size, max_units)

    def check_daily_loss_limit(self, loss: float, account_value: float) -> bool:
        if datetime.now().date() > self.daily_reset_time.date():
            self.daily_loss = 0.0
            self.daily_reset_time = datetime.now()
        self.daily_loss += loss
        loss_pct = (self.daily_loss / account_value) * 100
        if loss_pct >= self.max_daily_loss_percent:
            logging.warning(f"⚠️  Daily loss limit reached: {loss_pct:.2f}%")
            return False
        return True

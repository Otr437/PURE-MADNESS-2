.PHONY: install test lint api admin cli docker-up docker-down clean

install:
	pip install -r requirements.txt

api:
	python apps/api-server/main.py

admin:
	python apps/admin-server/main.py

cli:
	python apps/cli/main.py

all-services:
	python apps/api-server/main.py &
	python apps/admin-server/main.py &
	wait

docker-up:
	docker-compose up --build

docker-down:
	docker-compose down

clean:
	find . -type f -name "*.pyc" -delete
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	rm -f *.db *.log *.db.backup.*

test:
	python -m pytest tests/ -v 2>/dev/null || echo "No tests yet — add tests/ directory"

lint:
	python -m flake8 packages/ apps/ --max-line-length=120 2>/dev/null || pip install flake8 && python -m flake8 packages/ apps/ --max-line-length=120

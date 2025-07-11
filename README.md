# Privacy Preserving Expense Tracker


A secure expense tracking application that leverages Nillion's technology for private data storage. This application allows users to track their expenses while ensuring their financial data remains private and secure using Nillion's cryptographic infrastructure.

## Features

- Secure expense tracking with Nillion's Private Storage
- Create and manage expense records with amounts, categories, and descriptions
- Data encryption and secure storage
- RESTful API endpoints for expense management

## Prerequisites

- NodeJs 22+
- pnpm package manager
- Nillion wallet and API credentials

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Create a `.env` file in the root directory with the following variables:
   ```
   NILCHAIN_URL=your_nilchain_url
   NILAUTH_URL=your_nilauth_url
   NILDB_NODES=your_nildb_nodes
   BUILDER_PRIVATE_KEY=your_builder_private_key
   ```

## Running the Application

Development mode (with auto-reload):
```bash
pnpm dev
```

Production mode:
```bash
pnpm start
```

## API Endpoints

- `GET /health` - Check API server status
- `POST /api/vault/write` - Create new expense record(s)
- Additional endpoints for reading and managing expenses

## Tech Stack

- Express.js - Web application framework
- @nillion/nuc - Nillion's core SDK
- @nillion/secretvaults - Nillion's secure storage solution
- CORS - Cross-Origin Resource Sharing support
- dotenv - Environment variable management

## Security

This application uses Nillion's Secret Vaults to ensure that expense data is stored securely. Each expense record is encrypted and can only be accessed with proper authentication and authorization.

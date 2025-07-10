import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import fs from 'fs/promises';

loadEnv();

import {
    Keypair,
    NilauthClient,
    PayerBuilder,
    NucTokenBuilder,
    Command,
} from '@nillion/nuc';
import {
    SecretVaultBuilderClient,
    SecretVaultUserClient,
} from '@nillion/secretvaults';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const config = {
    NILCHAIN_URL: process.env.NILCHAIN_URL,
    NILAUTH_URL: process.env.NILAUTH_URL,
    NILDB_NODES: process.env.NILDB_NODES.split(','),
    BUILDER_PRIVATE_KEY: process.env.BUILDER_PRIVATE_KEY,
};

// Validate configuration
if (!config.BUILDER_PRIVATE_KEY) {
    console.error('❌ Please set BUILDER_PRIVATE_KEY in your .env file');
    process.exit(1);
}

let builderKeypair, userKeypair, builder, user, collectionId;

const EXPENSE_IDS_FILE = 'expense-ids.json';
let createdExpenseIds = [];

// Helper functions for persistent storage
async function loadExpenseIds() {
    try {
        const data = await fs.readFile(EXPENSE_IDS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // File doesn't exist or is invalid, start with empty array
        return [];
    }
}

async function saveExpenseIds() {
    try {
        await fs.writeFile(EXPENSE_IDS_FILE, JSON.stringify(createdExpenseIds, null, 2));
    } catch (error) {
        console.error('Failed to save expense IDs:', error);
    }
}

async function initializeNillion() {
    try {
        
        // Create keypairs for builder and user
        builderKeypair = Keypair.from(config.BUILDER_PRIVATE_KEY);
        userKeypair = Keypair.generate();

        // Create payer and nilauth client
        const payer = await new PayerBuilder()
            .keypair(builderKeypair)
            .chainUrl(config.NILCHAIN_URL)
            .build();

        const nilauth = await NilauthClient.from(config.NILAUTH_URL, payer);

        // Create builder client
        builder = await SecretVaultBuilderClient.from({
            keypair: builderKeypair,
            urls: {
                chain: config.NILCHAIN_URL,
                auth: config.NILAUTH_URL,
                dbs: config.NILDB_NODES,
            },
        });

        // Refresh token using existing subscription
        await builder.refreshRootToken();

        // Register builder (handle existing registration)
        try {
            const existingProfile = await builder.readProfile();
            console.log('✅ Builder already registered:', existingProfile.data.name);
        } catch (profileError) {
            try {
                await builder.register({
                    did: builderKeypair.toDid().toString(),
                    name: 'Expense Tracker',
                });
                console.log('✅ Builder registered successfully');
            } catch (registerError) {
                if (registerError.message.includes('duplicate key')) {
                    console.log('✅ Builder already registered (duplicate key)');
                } else {
                    throw registerError;
                }
            }
        }

        // Create user client
        user = await SecretVaultUserClient.from({
            baseUrls: config.NILDB_NODES,
            keypair: userKeypair,
        });

        // Create collection if it doesn't exist
        collectionId = randomUUID();
        const collection = {
            _id: collectionId,
            type: 'owned',
            name: 'Expense Tracker Collection',
            schema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'array',
                uniqueItems: true,
                items: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string', format: 'uuid' },
                        amount: { type: 'number', minimum: 0 },
                        cat: { type: 'string' },
                        desc: { type: 'string' },
                        date: { type: 'string', format: 'date-time' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['_id', 'amount', 'cat', 'desc'],
                },
            },
        };

        try {
            await builder.createCollection(collection);
            console.log('✅ Expense collection created successfully');
        } catch (error) {
            console.log('Collection may already exist:', error.message);
        }

        console.log('✅ Nillion initialization complete');
    } catch (error) {
        console.error('❌ Nillion initialization failed:', error);
        throw error;
    }
}

// Helper function to create delegation token
function createDelegationToken(operation) {
    return NucTokenBuilder.extending(builder.rootToken)
        .command(new Command(['nil', 'db', 'data', operation]))
        .audience(userKeypair.toDid())
        .expiresAt(Math.floor(Date.now() / 1000) + 3600) // 1 hour
        .build(builderKeypair.privateKey());
}

// Validation function
function validateExpense(expense) {
    if (!expense.amount || typeof expense.amount !== 'number' || expense.amount < 0) {
        return 'Amount must be a positive number';
    }
    
    if (!expense.cat || typeof expense.cat !== 'string' || expense.cat.trim() === '') {
        return 'Category must be a non-empty string';
    }
    
    if (!expense.desc || typeof expense.desc !== 'string' || expense.desc.trim() === '') {
        return 'Description must be a non-empty string';
    }
    
    return null;
}


app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Expense Tracker API Server is running' });
});

// CREATE - Add new expense(s)
app.post('/api/vault/write', async (req, res) => {
    try {
        console.log('🔍 Server received request:');
        console.log('  Headers:', req.headers);
        console.log('  Body:', JSON.stringify(req.body, null, 2));
        console.log('  Content-Type:', req.headers['content-type']);
        
        const dataToWrite = Array.isArray(req.body) ? req.body : [req.body];
        const newIds = [];
        
        for (const expense of dataToWrite) {
            const error = validateExpense(expense);
            if (error) {
                return res.status(400).json({ error });
            }
        }
        
        const results = [];
        
        for (const expense of dataToWrite) {
            const expenseData = {
                _id: randomUUID(),
                amount: expense.amount,
                cat: expense.cat,
                desc: expense.desc,
                date: expense.date || new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            const delegation = createDelegationToken('create');
            
            // Debug logging
            console.log('🔍 Debug Info:');
            console.log('  Collection ID:', collectionId);
            console.log('  User DID:', userKeypair.toDid().toString());
            console.log('  Builder DID:', builderKeypair.toDid().toString());
            console.log('  Delegation token:', delegation);
            console.log('  Expense data:', JSON.stringify(expenseData, null, 2));
            
            const createDataParams = {
                owner: userKeypair.toDid().toString(),
                acl: {
                    grantee: builderKeypair.toDid().toString(),
                    read: true,
                    write: true,
                    execute: true,
                },
                collection: collectionId,
                data: [expenseData],
            };
            
            console.log('  Create data params:', JSON.stringify(createDataParams, null, 2));
            
            try {
                const uploadResults = await user.createData(delegation, createDataParams);
                
                // Store the created expense ID
                createdExpenseIds.push(expenseData._id);
                newIds.push(expenseData._id);
                results.push({ 
                    data: expenseData, 
                    uploadResults,
                    permissions: {
                        granted: true,
                        grantee: builderKeypair.toDid().toString()
                    }
                });
            } catch (uploadError) {
                if (uploadError.message.includes('permission denied')) {
                    // If permission denied, return helpful message
                    return res.status(403).json({
                        error: 'Permission denied',
                        message: 'The app needs permission to create expenses on your behalf. Please grant access first.',
                        requiredPermissions: {
                            read: true,
                            write: true,
                            execute: true
                        }
                    });
                }
                throw uploadError;
            }
        }
        
        await saveExpenseIds();

        res.status(201).json({
            message: "Expense(s) written successfully",
            dataWritten: results,
            createdIds: newIds
        });
    } catch (error) {
        console.error('Create error:', error);
        console.error('Error details:', {
            message: error.message,
            cause: error.cause,
            stack: error.stack
        });
        res.status(500).json({ error: 'Failed to write expense data', details: error.message });
    }
});

app.get('/api/vault/read', async (req, res) => {
    try {
        if (createdExpenseIds.length === 0) {
            return res.json({
                totalRecords: 0,
                data: [],
                note: 'No expenses found'
            });
        }

        const allExpenses = [];
        const failedIds = [];
        
        console.log(`🔍 Attempting to read ${createdExpenseIds.length} expenses...`);
        
        for (const expenseId of createdExpenseIds) {
            try {
                const expenseData = await user.readData({
                    collection: collectionId,
                    document: expenseId,
                });
                allExpenses.push(expenseData.data);
                console.log(`✅ Successfully read expense: ${expenseId.substring(0, 8)}...`);
            } catch (error) {
                console.warn(`❌ Failed to read expense with ID ${expenseId}:`, error.message);
                failedIds.push(expenseId);
            }
        }
        
        // Clean up failed IDs
        if (failedIds.length > 0) {
            createdExpenseIds = createdExpenseIds.filter(id => !failedIds.includes(id));
            await saveExpenseIds();
            console.log(`🧹 Cleaned up ${failedIds.length} invalid expense IDs`);
        }
        
        res.json({
            totalRecords: allExpenses.length,
            data: allExpenses,
            failedCount: failedIds.length,
            note: `Showing ${allExpenses.length} expenses. ${failedIds.length > 0 ? `${failedIds.length} expenses could not be read.` : ''}`
        });
    } catch (error) {
        console.error('Read error:', error);
        res.status(500).json({ error: 'Failed to read expense data', details: error.message });
    }
});

app.get('/api/vault/read/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const expenseData = await user.readData({
            collection: collectionId,
            document: id,
        });

        res.json({ data: expenseData.data });
    } catch (error) {
        console.error('Read by ID error:', error);
        res.status(404).json({ error: 'Expense not found', details: error.message });
    }
});

app.post('/api/vault/permissions/grant', async (req, res) => {
    try {
        const grantResult = await user.grantAccess({
            collection: collectionId,
            document: req.body.documentId,
            acl: {
                grantee: builderKeypair.toDid().toString(),
                read: true,
                write: false,
                execute: false
            }
        });

        res.json({
            message: "Access granted successfully",
            result: grantResult
        });
    } catch (error) {
        console.error('Grant access error:', error);
        res.status(500).json({ error: 'Failed to grant access', details: error.message });
    }
});

// PERMISSIONS - Revoke access from builder
app.post('/api/vault/permissions/revoke', async (req, res) => {
    try {
        const revokeResult = await user.revokeAccess({
            collection: collectionId,
            document: req.body.documentId,
            grantee: builderKeypair.toDid().toString()
        });

        res.json({
            message: "Access revoked successfully",
            result: revokeResult
        });
    } catch (error) {
        console.error('Revoke access error:', error);
        res.status(500).json({ error: 'Failed to revoke access', details: error.message });
    }
});


// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

async function startServer() {
    try {
        await initializeNillion();
        
        app.listen(PORT, () => {
            console.log(`🚀 Expense Tracker API Server running on port ${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/health`);
            console.log(`📝 API Documentation:`);
            console.log(`   POST   /api/vault/write        - Create expense(s)`);
            console.log(`   GET    /api/vault/read         - Get all expenses`);
            console.log(`   GET    /api/vault/read/:id     - Get expense by ID`);
            console.log(`   PUT    /api/vault/update/:id   - Update expense by ID`);
            console.log(`   DELETE /api/vault/delete/:id   - Delete expense by ID`);
            console.log(`   DELETE /api/vault/remove/:id   - Remove expense by ID`);
            console.log(`   POST   /api/vault/delete       - Bulk delete expenses`);
            console.log(`   POST   /api/vault/remove-bulk  - Bulk remove expenses`);
            console.log(`   POST   /api/vault/update       - Bulk update expenses`);
            console.log(`   POST   /api/vault/permissions/grant  - Grant access to builder`);
            console.log(`   POST   /api/vault/permissions/revoke - Revoke access from builder`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer(); 






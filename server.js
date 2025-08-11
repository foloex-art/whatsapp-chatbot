const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// In-memory storage for user sessions and orders
const userSessions = new Map();
const orders = new Map();

// Sample restaurant menu
const menu = {
    starters: [
        { id: 'S1', name: 'Spring Rolls', price: 8.99, description: 'Crispy vegetable spring rolls (4 pcs)' },
        { id: 'S2', name: 'Chicken Wings', price: 12.99, description: 'Spicy buffalo wings (8 pcs)' },
        { id: 'S3', name: 'Garlic Bread', price: 6.99, description: 'Homemade garlic bread with herbs' }
    ],
    mains: [
        { id: 'M1', name: 'Margherita Pizza', price: 16.99, description: 'Fresh tomato, mozzarella, basil' },
        { id: 'M2', name: 'Chicken Burger', price: 14.99, description: 'Grilled chicken with lettuce, tomato' },
        { id: 'M3', name: 'Pasta Carbonara', price: 18.99, description: 'Creamy pasta with bacon and parmesan' },
        { id: 'M4', name: 'Fish & Chips', price: 19.99, description: 'Beer battered cod with crispy fries' }
    ],
    desserts: [
        { id: 'D1', name: 'Chocolate Cake', price: 7.99, description: 'Rich chocolate cake with vanilla ice cream' },
        { id: 'D2', name: 'Tiramisu', price: 8.99, description: 'Classic Italian dessert' }
    ],
    drinks: [
        { id: 'DR1', name: 'Coca Cola', price: 3.99, description: 'Classic soft drink' },
        { id: 'DR2', name: 'Fresh Orange Juice', price: 4.99, description: 'Freshly squeezed orange juice' },
        { id: 'DR3', name: 'Coffee', price: 3.49, description: 'Freshly brewed coffee' }
    ]
};

// Helper functions
function getUserSession(phoneNumber) {
    if (!userSessions.has(phoneNumber)) {
        userSessions.set(phoneNumber, {
            cart: [],
            currentStep: 'welcome',
            orderInProgress: false
        });
    }
    return userSessions.get(phoneNumber);
}

function formatMenuItem(item) {
    return `${item.id}. ${item.name} - $${item.price}\n   ${item.description}`;
}

function formatMenuCategory(categoryName, items) {
    let message = `??? *${categoryName.toUpperCase()}*\n\n`;
    items.forEach(item => {
        message += formatMenuItem(item) + '\n\n';
    });
    return message;
}

function formatCart(cart) {
    if (cart.length === 0) {
        return '?? Your cart is empty.\n\nType "menu" to browse our menu!';
    }
    
    let message = '?? *YOUR CART*\n\n';
    let total = 0;
    
    cart.forEach(item => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        message += `${item.name} x${item.quantity} - $${subtotal.toFixed(2)}\n`;
    });
    
    message += `\n*Total: $${total.toFixed(2)}*\n\n`;
    message += 'Type "checkout" to place your order\n';
    message += 'Type "clear" to empty cart\n';
    message += 'Type "menu" to continue shopping';
    
    return message;
}

function findMenuItem(itemId) {
    const allItems = [...menu.starters, ...menu.mains, ...menu.desserts, ...menu.drinks];
    return allItems.find(item => item.id.toLowerCase() === itemId.toLowerCase());
}

function generateOrderId() {
    return 'ORD' + Date.now().toString().slice(-6);
}

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Restaurant WhatsApp Ordering Bot is running! ??');
});

// Webhook endpoint for incoming WhatsApp messages
app.post('/webhook', (req, res) => {
    const incomingMessage = req.body.Body.toLowerCase().trim();
    const fromNumber = req.body.From;
    
    console.log(`Received message: "${incomingMessage}" from ${fromNumber}`);
    
    const session = getUserSession(fromNumber);
    let responseMessage = '';
    
    // Handle different commands
    if (incomingMessage.includes('hello') || incomingMessage.includes('hi') || incomingMessage === 'start') {
        responseMessage = `?? *Welcome to Delicious Bites Restaurant!*

We're delighted to serve you through WhatsApp! 

?? *Available Commands:*
• "menu" - Browse our full menu
• "cart" - View your current order
• "help" - Get assistance
• "track [order_id]" - Track your order

Ready to order? Type "menu" to get started! ??`;
        
    } else if (incomingMessage === 'menu') {
        responseMessage = `??? *OUR MENU*

Which category would you like to explore?

?? Type "starters" for appetizers
?? Type "mains" for main courses  
?? Type "desserts" for sweet treats
?? Type "drinks" for beverages

Or type "full" to see the complete menu`;
        
    } else if (incomingMessage === 'starters') {
        responseMessage = formatMenuCategory('Starters', menu.starters);
        responseMessage += '\nTo add an item, type: add [item_id] [quantity]\nExample: "add S1 2"';
        
    } else if (incomingMessage === 'mains') {
        responseMessage = formatMenuCategory('Main Courses', menu.mains);
        responseMessage += '\nTo add an item, type: add [item_id] [quantity]\nExample: "add M1 1"';
        
    } else if (incomingMessage === 'desserts') {
        responseMessage = formatMenuCategory('Desserts', menu.desserts);
        responseMessage += '\nTo add an item, type: add [item_id] [quantity]\nExample: "add D1 1"';
        
    } else if (incomingMessage === 'drinks') {
        responseMessage = formatMenuCategory('Drinks', menu.drinks);
        responseMessage += '\nTo add an item, type: add [item_id] [quantity]\nExample: "add DR1 2"';
        
    } else if (incomingMessage === 'full') {
        responseMessage = formatMenuCategory('Starters', menu.starters);
        responseMessage += formatMenuCategory('Main Courses', menu.mains);
        responseMessage += formatMenuCategory('Desserts', menu.desserts);
        responseMessage += formatMenuCategory('Drinks', menu.drinks);
        responseMessage += '\nTo add an item, type: add [item_id] [quantity]\nExample: "add M1 2"';
        
    } else if (incomingMessage.startsWith('add ')) {
        const parts = incomingMessage.split(' ');
        if (parts.length >= 3) {
            const itemId = parts[1].toUpperCase();
            const quantity = parseInt(parts[2]);
            const item = findMenuItem(itemId);
            
            if (item && quantity > 0) {
                // Check if item already exists in cart
                const existingItem = session.cart.find(cartItem => cartItem.id === item.id);
                if (existingItem) {
                    existingItem.quantity += quantity;
                } else {
                    session.cart.push({
                        id: item.id,
                        name: item.name,
                        price: item.price,
                        quantity: quantity
                    });
                }
                responseMessage = `? Added ${quantity}x ${item.name} to your cart!\n\nType "cart" to view your order or "menu" to continue shopping.`;
            } else {
                responseMessage = `? Invalid item ID or quantity. Please check the menu and try again.\n\nExample: "add M1 2"`;
            }
        } else {
            responseMessage = `? Invalid format. Please use: add [item_id] [quantity]\n\nExample: "add M1 2"`;
        }
        
    } else if (incomingMessage === 'cart') {
        responseMessage = formatCart(session.cart);
        
    } else if (incomingMessage === 'clear') {
        session.cart = [];
        responseMessage = `?? Your cart has been cleared.\n\nType "menu" to start shopping again!`;
        
    } else if (incomingMessage === 'checkout') {
        if (session.cart.length === 0) {
            responseMessage = `?? Your cart is empty! Type "menu" to browse our delicious options.`;
        } else {
            const orderId = generateOrderId();
            const total = session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            
            // Store the order
            orders.set(orderId, {
                id: orderId,
                phoneNumber: fromNumber,
                items: [...session.cart],
                total: total,
                status: 'confirmed',
                orderTime: new Date(),
                estimatedDelivery: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
            });
            
            // Clear the cart
            session.cart = [];
            
            responseMessage = `?? *ORDER CONFIRMED!*

Order ID: *${orderId}*
Total: *$${total.toFixed(2)}*

?? Your order will be prepared and delivered in approximately 25-30 minutes.

?? Please have $${total.toFixed(2)} ready for cash payment upon delivery.

?? Track your order anytime by typing: track ${orderId}

Thank you for choosing Delicious Bites! ????`;
        }
        
    } else if (incomingMessage.startsWith('track ')) {
        const orderId = incomingMessage.split(' ')[1].toUpperCase();
        const order = orders.get(orderId);
        
        if (order) {
            const currentTime = new Date();
            const orderTime = order.orderTime;
            const minutesElapsed = Math.floor((currentTime - orderTime) / (1000 * 60));
            
            let status = '';
            if (minutesElapsed < 5) {
                status = '?? Being prepared in kitchen';
            } else if (minutesElapsed < 20) {
                status = '????? Cooking in progress';
            } else if (minutesElapsed < 30) {
                status = '?? Out for delivery';
            } else {
                status = '? Delivered';
            }
            
            responseMessage = `?? *ORDER TRACKING*

Order ID: ${order.id}
Status: ${status}
Total: $${order.total.toFixed(2)}
Order Time: ${orderTime.toLocaleTimeString()}

${minutesElapsed < 30 ? `Estimated delivery: ${order.estimatedDelivery.toLocaleTimeString()}` : 'Delivered! We hope you enjoyed your meal! ??'}`;
        } else {
            responseMessage = `? Order not found. Please check your order ID and try again.`;
        }
        
    } else if (incomingMessage === 'help') {
        responseMessage = `?? *HELP & COMMANDS*

?? *Ordering Commands:*
• "menu" - Browse our menu
• "starters/mains/desserts/drinks" - Specific categories
• "add [item_id] [quantity]" - Add items to cart
• "cart" - View your current order
• "clear" - Empty your cart
• "checkout" - Place your order

?? *Order Tracking:*
• "track [order_id]" - Check order status

?? *Restaurant Hours:*
Monday - Sunday: 11:00 AM - 11:00 PM

?? *Contact:*
For urgent queries, call: (555) 123-4567

Need help? Just ask! ??`;
        
    } else if (incomingMessage.includes('bye') || incomingMessage.includes('goodbye')) {
        responseMessage = `?? Thank you for visiting Delicious Bites!

We hope to serve you again soon. Have a wonderful day! ????

Type "hello" anytime to start a new order!`;
        
    } else {
        responseMessage = `?? I didn't understand that command.

?? *Quick Commands:*
• "menu" - Browse our menu
• "cart" - View your order  
• "help" - Get assistance

Type "help" for a complete list of commands! ??`;
    }
    
    // Send response back via Twilio
    client.messages.create({
        from: twilioWhatsAppNumber,
        to: fromNumber,
        body: responseMessage
    })
    .then(message => {
        console.log(`Message sent: ${message.sid}`);
        res.status(200).send('Message sent successfully');
    })
    .catch(error => {
        console.error('Error sending message:', error);
        res.status(500).send('Error sending message');
    });
});

// Admin endpoint to view all orders (for restaurant staff)
app.get('/orders', (req, res) => {
    const allOrders = Array.from(orders.values()).map(order => ({
        id: order.id,
        phoneNumber: order.phoneNumber,
        items: order.items,
        total: order.total,
        status: order.status,
        orderTime: order.orderTime,
        estimatedDelivery: order.estimatedDelivery
    }));
    
    res.json({
        totalOrders: allOrders.length,
        orders: allOrders
    });
});

// Start server
app.listen(port, () => {
    console.log(`Restaurant Ordering Bot is running on port ${port} ??`);
    console.log(`Webhook URL: http://your-domain.com/webhook`);
    console.log(`Orders admin panel: http://your-domain.com/orders`);
});
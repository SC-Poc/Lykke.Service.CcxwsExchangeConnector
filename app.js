const ccxws = require("ccxws");
const ccxt = require('ccxt');
const express = require('express')
const path = require('path');
const LogFactory =  require('./utils/logFactory')
const RabbitMq = require('./rabbitMq/rabbitMq')
const getSettings = require('./settings/settings')
const assetPairsMapping = require('./utils/assetPairsMapping')
const exchangesMapping = require('./utils/exchangesMapping')
const packageJson = require('./package.json')
const exchangeEventsHandler = require('./exchangeEventsHandler')

let settings
let log
let rabbitMq

(async function main() {    
    settings = (await getSettings()).CcxwsExchangeConnector
    log = LogFactory.create(path.basename(__filename), settings.Main.LoggingLevel)

    log.info(`Main started...`)

    process.on('uncaughtException',  e => log.warn(`Unhandled error: ${e}, ${e.stack}.`))
    process.on('unhandledRejection', e => log.warn(`Unhandled error: ${e}, ${e.stack}.`))

    rabbitMq = new RabbitMq(settings.RabbitMq, settings.Main.LoggingLevel)
    await rabbitMq.getChannel()

    subscribeToExchangesData()

    startWebServer()
})();

async function subscribeToExchangesData() {
    const exchanges = settings.Main.Exchanges
    const symbols = settings.Main.Symbols

    await Promise.all(exchanges.map (exchangeName =>
        subscribeToExchangeData(exchangeName, symbols)
    ))
}

async function subscribeToExchangeData(exchangeName, symbols) {
    const exchange = new ccxt[exchangeName]()
    const exchange_ws = exchangesMapping.MapExchangeCcxtToCcxws(exchangeName)
    exchange_ws.reconnectIntervalMs = settings.Main.ReconnectIntervalMs

    let allMarkets = []

    try {
        exchange.timeout = 30 * 1000
        allMarkets = await exchange.loadMarkets()
    } catch (e) {
        log.warn(`${exchange.id} can't load markets: ${e}`)
        return
    }

    try {
        let availableMarkets = []
        if (symbols.includes('*')) {
            for (var key of Object.keys(allMarkets)) {
                availableMarkets.push(allMarkets[key])
            }
        } else {
            availableMarkets = getAvailableMarketsForExchange(exchange, symbols)
        }

        if (availableMarkets.length === 0) {
            log.warn(`${exchange.id} doesn't have any symbols from config.`)
            return
        }

        const handler = new exchangeEventsHandler(exchange, settings, rabbitMq)

        exchange_ws.on("l2snapshot", async orderBook => await handler.l2snapshotEventHandle(orderBook))
        exchange_ws.on("l2update", async updateOrderBook => await handler.l2updateEventHandle(updateOrderBook))
        exchange_ws.on("trade", async trade => await handler.tradesEventHandle(trade))

        availableMarkets.forEach(market => {
            try {
                if (settings.Main.Subscribe.OrderBooks)
                {
                    if (exchange_ws.hasLevel2Snapshots)
                        exchange_ws.subscribeLevel2Snapshots(market)
                    else 
                        exchange_ws.subscribeLevel2Updates(market)
                }

                if (settings.Main.Subscribe.Trades)
                    exchange_ws.subscribeTrades(market)
            } catch (e) {
                log.warn(`${exchange.id} can't subscribe : ${e}`)
                return
            }
        });
    } catch (e) {
        log.warn(`${exchange.id} can't load markets: ${e}`)
        return
    }
}

function getAvailableMarketsForExchange(exchange, symbols) {
    const result = []

    for (const symbol of symbols) {
        let market = exchange.findMarket(assetPairsMapping.TryToMapAssetPairForward(symbol, exchange, settings))
        // Inversed - first trying to map, then try to use original
        // Example:
        // if in the cofig 'symbols' contains BTC/USD and 'mapping' contains USD -> USDT
        // then it first tries to find BTC/USDT and if no such asset pair then looks for BTC/USD
        const exchangeHasMapped = typeof market === "object"
        if (exchangeHasMapped) {
            result.push(market)
        } else {
            market = exchange.findMarket(symbol)
            const exchangeHas = typeof market === "object"
            if (exchangeHas) {
                result.push(market)
            }
        }
    }

    return result
}

function startWebServer() {
    const response = {
        "Name": "Lykke.Service.CcxwsExchangeConnector",
        "Version": packageJson.version,
        "Env": null,
        "IsDebug": false,
        "IssueIndicators": []
      }
      
    const app = express()

    app.get('/api/isAlive', function (req, res) {
        res.header("Content-Type",'application/json')
        res.send(JSON.stringify(response, null, 4))
    })
    
    app.get('/api/settings', async function (req, res) {
        res.header("Content-Type",'application/json')
        res.send(JSON.stringify(settings, null, 4))
    })

    const server = app.listen(5000, function () {
       let host = server.address().address
       const port = server.address().port

       if (host === "::") { 
           host = "localhost" }
        log.info(`Listening at http://${host}:${port}`)
    })
}
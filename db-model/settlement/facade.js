/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.
 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 * Valentin Genev <valentin.genev@modusbox.com>
 * Deon Botha <deon.botha@modusbox.com>
 --------------
 ******/

'use strict'

const Db = require('../index')
const settlementWindowModel = require('../settlementWindow')

const Facade = {
  triggerEvent: async function ({ settlementId, settlementWindowsIdList, reason }, enums = {}) {
    try {
      let settlementSettlementWindow = {}
      let settlementSettlementWindowList = []
      let settlementWindowStateList = []
      let idLists = settlementWindowsIdList.map(v => v.id)
      const settlementWindowStates = await settlementWindowModel.getByListOfIds(idLists, enums.settlementWindowStates)
      if (!settlementWindowStates.length) {
        await trx.rollback
        let err = new Error('2001')
        throw err
      }
      for (let settlementWindowState of settlementWindowStates) {
        let { state, settlementWindowId } = settlementWindowState
        if (state !== enums.settlementWindowStates.CLOSED) {
          let err = new Error('2001')
          throw err
        } else {
          settlementSettlementWindowList.push({
            settlementId,
            settlementWindowId
          })
          settlementWindowStateList.push({
            settlementWindowId,
            settlementWindowStateId: enums.settlementWindowStates.PENDING_SETTLEMENT
          })
        }
      }
      // all windowses are closed. we can proceed with transaction.
      const knex = await Db.getKnex()
      return await knex.transaction(async (trx) => {
        try {
          await Promise.all([
            // change states
            await knex.batchInsert('settlementSettlementWindow', settlementSettlementWindowList).transacting(trx),
            await knex.batchInsert('settlementWindowStateChange', settlementWindowStateList).transacting(trx),
            await knex('settlementStateChange').transacting(trx)
              .insert({
                settlementId,
                settlementStateId: enums.settlementStates.PENDING_SETTLEMENT
              }, 'settlementStateChangeId'),
            // select transferFulfilments
            await knex('transferFulfilment').transacting(trx)
              .leftJoin('transferStateChange AS tsc', function () {
                this.on('tsc.transferId', '=', 'transferFulfilment.transferId')
                  .onIn('tsc.transferStateId', [enums.transferStates.COMMITTED])
              })
              .join('transferParticipant AS tp', 'tp.transferId', 'transferFulfilment.transferId')
              .join('settlementWindow as sw', 'sw.settlementWindowId', 'transferFulfilment.settlementWindowId')
              .select(
                'tp.participantCurrencyId as participantCurrencyId',
                'tp.transferParticipantRoleTypeId as transferParticipantRoleTypeId',
                'tp.ledgerEntryTypeId as ledgerEntryTypeId',
                'tp.amount as amount'
              )
              .whereIn('sw.settlementWindowId', idLists)
          ])
            .then(async ([
              settlementSettlementWindowIdsList,
              settlementWindowStateIdsList,
              settlementStateChangeId,
              transferParticipantList
            ]) => {
              let settlementTransferParticipantMap = new Map()
              for (let transferParticipant of transferParticipantList) {
                let {
                  participantCurrencyId,
                  transferParticipantRoleTypeId,
                  ledgerEntryTypeId,
                  amount
                } = transferParticipant
                let stpMapKey = `${participantCurrencyId}_${transferParticipantRoleTypeId}_${ledgerEntryTypeId}`
                if (!settlementTransferParticipantMap.has(stpMapKey)) {
                  settlementTransferParticipantMap.set(stpMapKey, {settlementId, ...transferParticipant})
                } else {
                  let oldTransferParticipant = settlementTransferParticipantMap.get(stpMapKey)
                  let newAmount = { amount: oldTransferParticipant.amount + amount }
                  let newTp = {
                    settlementId,
                    ...transferParticipant,
                    ...newAmount
                  }
                  settlementTransferParticipantMap.set(stpMapKey, newTp) // we have map with objects to insert into settlementTransferParticipant as a batch
                }
              }
              let settlementTransferParticipantList = Array.from(settlementTransferParticipantMap.values())
              let settlementParticipantCurrencyMap = new Map()
              for (let settlementTransferParticipant of settlementTransferParticipantList) {
                let {
                  participantCurrencyId,
                  transferParticipantRoleTypeId,
                  ledgerEntryTypeId,
                  amount
                } = settlementTransferParticipant
                let spcKey = participantCurrencyId
                amount =
                  (ledgerEntryTypeId === enums.ledgerEntryTypes.INTERCHANGE_FEE)
                    ? (-amount)
                    : ((ledgerEntryTypeId === enums.ledgerEntryTypes.PRINCIPLE_VALUE) && (transferParticipantRoleTypeId === enums.transferParticipantRoleTypes.PAYER_DFSP))
                      ? amount
                      : ((ledgerEntryTypeId === enums.ledgerEntryTypes.PRINCIPLE_VALUE) && (transferParticipantRoleTypeId === enums.transferParticipantRoleTypes.PAYEE_DFSP))
                        ? (-amount)
                        : null
                let spc = {
                  settlementId,
                  participantCurrencyId,
                  netAmount: amount
                }
                if (!settlementParticipantCurrencyMap.has(spcKey)) {
                  settlementParticipantCurrencyMap.set(spcKey, spc)
                } else {
                  let oldSettlementTransferParticipant = settlementParticipantCurrencyMap.get(spcKey)
                  let newNetAmount = { netAmount: oldSettlementTransferParticipant.netAmount + amount }
                  let newPc = {
                    ...spc,
                    ...newNetAmount
                  }
                  settlementParticipantCurrencyMap.set(spcKey, newPc) // we have map with objects to insert into settlementParticipantCurrency
                }
              }
              let settlementParticipantCurrencyList = Array.from(settlementParticipantCurrencyMap.values())
              await Promise.all([
                await knex.batchInsert('settlementTransferParticipant', settlementTransferParticipantList).transacting(trx),
                await knex.batchInsert('settlementParticipantCurrency', settlementParticipantCurrencyList).transacting(trx)
              ]).then(async ([
                settlementTranasferParticipantIdList,
                settlementParticipantCurrencyIdList
              ]) => {
                let settlementParticipantCurrencyList = []
                for (let settlementParticipantCurrency of settlementParticipantCurrencyIdList) {
                  settlementParticipantCurrencyList.push({
                    settlementParticipantCurrencyId: settlementParticipantCurrency,
                    reason,
                    settlementStateId: enums.settlementStates.PENDING_SETTLEMENT 
                  })
                }
                await knex.batchInsert('settlementParticipantCurrencyStateChange', settlementParticipantCurrencyList).transacting(trx)
                trx.commit
                return true // should return object for building responses  
              })
              .catch((err) => {
                throw err
              })
            }).catch((err) => {
              throw err
            })
        } catch (err) {
          await trx.rollback
          throw err
        }
      }).catch((err) => {
        throw err
      })
    } catch (err) { //
      throw err
    }
  } // trigerEvent
} // Facade

module.exports = Facade

// -- * insert into settlementSettlementWindow all valid settlement windowses
// -- * batch insert all statuses for settlementWindow and settlement
//   -- [settlementSettlementWindowsIdsList]
//   -- make a map based on all the differentId combinations over the list from the find and sum the amount
//   -- insert all map keys into settlementTransfeParticipant
//   -- insert into settlementParticipantCurrency netAmount grouped by some other stuff 
//   -- return the ids of the inserted settlementTransferParticipants and the map

// get all settlementWindow statuses 
// check if a status is not closed.

// Promise.all ([
//   batchInsert settlementSettlementWindowId;
//   insert into settlementStateChange new state - pending settlement;
//   batchInsert into settlementWindowStateChange new state = PENDING_SETTLEMENT
//   select * from transferFulfilment where settlementWindowId is part of the input list
//  ])
//   -- make two maps based on all the differentId combinations over the list from the find and sum the amount
//   --  and prepare the participantCurrency array for batch inserst from the same map
// return the map and insert each 
// Promoise.all ([batchInsert map keys and settlementParticipantCurrencies with netAmount])
// into settlementParticipantCurrency depending on participantCurrency and adjusting the netAmount
// batchInsert change the state of the settlementParticipantCurrencies from the second list


// DONE

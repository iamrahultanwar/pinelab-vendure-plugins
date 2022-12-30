import { Inject, Injectable } from '@nestjs/common';
import {
  ActiveOrderService,
  ChannelService,
  CustomerService,
  EntityHydrator,
  ErrorResult,
  EventBus,
  HistoryService,
  ID,
  JobQueue,
  JobQueueService,
  LanguageCode,
  Logger,
  OrderService,
  OrderStateTransitionError,
  PaymentMethodService,
  ProductVariant,
  ProductVariantService,
  RequestContext,
  SerializedRequestContext,
  UserInputError,
} from '@vendure/core';
import { loggerCtx, PLUGIN_INIT_OPTIONS } from './constants';
import { StripeSubscriptionPluginOptions } from './stripe-subscription.plugin';
import { IncomingStripeWebhook } from './stripe.types';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import {
  OrderWithSubscriptions,
  VariantWithSubscriptionFields,
} from './subscription-custom-fields';
import { StripeClient } from './stripe.client';
import { Stripe } from 'stripe';
import {
  getDayRate,
  getDaysUntilNextStartDate,
  getNextStartDate,
  printMoney,
} from './util';
import {
  StripeSubscriptionPricing,
  StripeSubscriptionPricingInput,
} from './generated/graphql';
import { Schedule, schedules } from './schedules';
import { stripeSubscriptionHandler } from './stripe-subscription.handler';

export interface StripeHandlerConfig {
  paymentMethodCode: string;
  stripeClient: StripeClient;
  webhookSecret: string;
  downpaymentLabel?: string;
  prorationLabel?: string;
}

export interface JobData {
  action: 'createSubscriptionsForOrder';
  ctx: SerializedRequestContext;
  orderCode: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}

@Injectable()
export class StripeSubscriptionService {
  constructor(
    private paymentMethodService: PaymentMethodService,
    private activeOrderService: ActiveOrderService,
    private variantService: ProductVariantService,
    private entityHydrator: EntityHydrator,
    private channelService: ChannelService,
    private orderService: OrderService,
    private historyService: HistoryService,
    @Inject(PLUGIN_INIT_OPTIONS)
    private options: StripeSubscriptionPluginOptions,
    private eventBus: EventBus,
    private jobQueueService: JobQueueService,
    private customerService: CustomerService
  ) {}

  private jobQueue!: JobQueue<JobData>;

  async onModuleInit() {
    // Create jobQueue with handlers
    this.jobQueue = await this.jobQueueService.createQueue({
      name: 'stripe-subscription',
      process: async ({ data, id }) => {
        try {
          const ctx = RequestContext.deserialize(data.ctx);
          await this.createSubscriptions(
            ctx,
            data.orderCode,
            data.stripeCustomerId,
            data.stripePaymentMethodId
          );
        } catch (error) {
          Logger.warn(
            `Failed to process job ${data.action} (${id}) for channel ${data.ctx._channel.token}: ${error}`,
            loggerCtx
          );
          throw error;
        }
      },
    });
  }

  async createStripeSubscriptionPaymentIntent(
    ctx: RequestContext
  ): Promise<string> {
    const order = (await this.activeOrderService.getActiveOrder(
      ctx,
      undefined
    )) as OrderWithSubscriptions;
    if (!order) {
      throw new UserInputError('No active order for session');
    }
    await this.entityHydrator.hydrate(ctx, order, {
      relations: ['customer', 'shippingLines', 'lines.productVariant'],
      applyProductVariantPrices: true,
    });
    if (!order.lines?.length) {
      throw new UserInputError('Cannot create payment intent for empty order');
    }
    if (!order.customer) {
      throw new UserInputError(
        'Cannot create payment intent for order without customer'
      );
    }
    if (!order.shippingLines?.length) {
      throw new UserInputError(
        'Cannot create payment intent for order without shippingMethod'
      );
    }
    const intent = await this.createSetupIntent(ctx, order);
    return intent.client_secret!;
  }

  /**
   * Used for previewing the prices including VAT of a subscription
   */
  async getSubscriptionPricing(
    ctx: RequestContext,
    input?: Partial<StripeSubscriptionPricingInput>,
    variant?: VariantWithSubscriptionFields
  ): Promise<StripeSubscriptionPricing> {
    if (!variant && !input?.productVariantId) {
      throw Error(
        `Either variant or input.productvariantId is needed to calculate pricing!`
      );
    }
    if (!variant) {
      variant = (await this.variantService.findOne(
        ctx,
        input!.productVariantId!
      )) as VariantWithSubscriptionFields;
    }
    if (!variant) {
      throw new UserInputError(
        `No variant found with id ${input!.productVariantId}`
      );
    }
    const schedule = await this.getSchedule(variant);
    if (
      schedule.billingInterval.valueOf() !== schedule.durationInterval.valueOf()
    ) {
      throw Error(
        `Not implemented yet: billingInterval and durationInterval have to be equal`
      ); // FIXME
    }
    const billingsPerDuration = schedule.durationCount / schedule.billingCount; // TODO Only works when the duration and billing intervals are the same... should be a function
    const totalSubscriptionPrice = variant.price * billingsPerDuration;
    const dayRate = getDayRate(
      totalSubscriptionPrice,
      schedule.durationInterval!,
      schedule.durationCount!
    );
    const downpayment =
      input?.downpayment || input?.downpayment === 0
        ? input.downpayment
        : schedule.downpayment;
    const recurringPrice = Math.floor(
      variant.price - downpayment / billingsPerDuration
    );
    const now = new Date();
    const subscriptionStartDate = getNextStartDate(
      now,
      schedule.billingInterval,
      schedule.startDate
    );
    const daysUntilStart = getDaysUntilNextStartDate(
      input?.startDate || now,
      subscriptionStartDate
    );
    const totalProratedAmount = daysUntilStart * dayRate;
    return {
      downpayment: downpayment,
      totalProratedAmount: totalProratedAmount,
      proratedDays: daysUntilStart,
      dayRate,
      recurringPrice: recurringPrice,
      interval: schedule.billingInterval,
      intervalCount: schedule.billingCount,
      amountDueNow: downpayment + totalProratedAmount,
      subscriptionStartDate,
    };
  }

  async getSchedule(variant: VariantWithSubscriptionFields): Promise<Schedule> {
    const schedule = schedules.find(
      (s) => s.name === variant!.customFields.subscriptionSchedule
    );
    if (!schedule) {
      throw Error(
        `No schedule found with name "${variant.customFields.subscriptionSchedule}"`
      );
    }
    return schedule;
  }

  private async createSetupIntent(
    ctx: RequestContext,
    order: OrderWithSubscriptions
  ): Promise<Stripe.SetupIntent> {
    const { stripeClient } = await this.getStripeHandler(ctx, order.id);
    const stripeCustomer = await stripeClient.getOrCreateClient(order.customer);
    this.customerService
      .update(ctx, {
        id: order.customer.id,
        customFields: {
          stripeCustomerId: stripeCustomer.id,
        },
      })
      .catch((err) =>
        Logger.error(
          `Failed to update stripeCustomerId ${stripeCustomer.id} for ${order.customer.emailAddress}`,
          loggerCtx,
          err
        )
      );
    return stripeClient.setupIntents.create({
      customer: stripeCustomer.id,
      payment_method_types: ['card'], // TODO make configurable per channel
      usage: 'off_session',
      metadata: {
        orderCode: order.code,
        channelToken: ctx.channel.token,
        amount: order.totalWithTax,
      },
    });
  }

  async handlePaymentCompleteEvent(
    { type, data: { object: eventData } }: IncomingStripeWebhook,
    signature: string | undefined,
    rawBodyPayload: Buffer
  ): Promise<void> {
    if (type !== 'setup_intent.succeeded') {
      Logger.info(
        `Received incoming '${type}' webhook, not processing this event.`,
        loggerCtx
      );
      return;
    }
    const orderCode = eventData.metadata.orderCode;
    const channelToken = eventData.metadata.channelToken;
    if (!orderCode) {
      throw Error(
        `Incoming webhook is missing metadata.orderCode, cannot process this event`
      );
    }
    if (!channelToken) {
      throw Error(
        `Incoming webhook is missing metadata.channelToken, cannot process this event`
      );
    }
    const ctx = await this.createContext(channelToken);
    const order = await this.orderService.findOneByCode(ctx, orderCode);
    if (!order) {
      throw Error(`Cannot find order with code ${orderCode}`);
    }
    if (!eventData.customer) {
      await this.logOrderHistory(
        ctx,
        order.id,
        `No customer ID found in incoming webhook. Can not create subscriptions for this order.`
      );
      throw Error(`No customer found in webhook data for order ${order.code}`);
    }
    // Create subscriptions for customer
    const { stripeClient, paymentMethodCode } = await this.getStripeHandler(
      ctx,
      order.id
    );
    if (!this.options?.disableWebhookSignatureChecking) {
      stripeClient.validateWebhookSignature(rawBodyPayload, signature);
    }
    await this.jobQueue.add(
      {
        action: 'createSubscriptionsForOrder',
        ctx: ctx.serialize(),
        orderCode: order.code,
        stripePaymentMethodId: eventData.payment_method,
        stripeCustomerId: eventData.customer,
      },
      { retries: 1 }
    ); // Only 1 try, because subscription creation isn't transaction-proof
    // Status is complete, we can settle payment
    if (order.state !== 'ArrangingPayment') {
      const transitionToStateResult = await this.orderService.transitionToState(
        ctx,
        order.id,
        'ArrangingPayment'
      );
      if (transitionToStateResult instanceof OrderStateTransitionError) {
        throw Error(
          `Error transitioning order ${order.code} from ${transitionToStateResult.fromState} to ${transitionToStateResult.toState}: ${transitionToStateResult.message}`
        );
      }
    }
    const addPaymentToOrderResult = await this.orderService.addPaymentToOrder(
      ctx,
      order.id,
      {
        method: paymentMethodCode,
        metadata: {
          setupIntentId: eventData.id,
          amount: eventData.metadata.amount,
        },
      }
    );
    if ((addPaymentToOrderResult as ErrorResult).errorCode) {
      throw Error(
        `Error adding payment to order ${order.code}: ${
          (addPaymentToOrderResult as ErrorResult).message
        }`
      );
    }
    Logger.info(
      `Successfully settled payment for order ${order.code} for channel ${channelToken}`
    );
  }

  /**
   * Create subscriptions for customer based on order
   */
  private async createSubscriptions(
    ctx: RequestContext,
    orderCode: string,
    stripeCustomerId: string,
    stripePaymentMethodId: string
  ): Promise<void> {
    const order = (await this.orderService.findOneByCode(ctx, orderCode, [
      'customer',
      'lines',
      'lines.productVariant',
    ])) as OrderWithSubscriptions;
    if (!order) {
      throw Error(`Cannot find order with code ${orderCode}`);
    }
    const { stripeClient } = await this.getStripeHandler(ctx, order.id);
    const customer = await stripeClient.customers.retrieve(stripeCustomerId);
    if (!customer) {
      throw Error(
        `Failed to create subscription for ${stripeCustomerId} because the customer doesn't exist in Stripe`
      );
    }
    const product = await stripeClient.products.create({
      name: `Order ${order.code} - ${order.customer.emailAddress}`,
    });
    for (const orderLine of order.lines) {
      const pricing = await this.getSubscriptionPricing(
        ctx,
        undefined,
        orderLine.productVariant
      );
      Logger.info(
        `Creating subscriptions with pricing ${JSON.stringify(pricing)}`,
        loggerCtx
      );
      try {
        const recurring = await stripeClient.createOffSessionSubscription({
          customerId: stripeCustomerId,
          productId: product.id,
          currencyCode: order.currencyCode,
          amount: pricing.recurringPrice,
          interval: pricing.interval,
          intervalCount: pricing.intervalCount,
          paymentMethodId: stripePaymentMethodId,
          startDate: pricing.subscriptionStartDate,
          proration: true,
          description: orderLine.productVariant.name,
        });
        Logger.info(
          `Created recurring subscription for ${order.code}`,
          loggerCtx
        );
        await this.logOrderHistory(
          ctx,
          order.id,
          `Created subscription ${recurring.id}: ${printMoney(
            pricing.recurringPrice
          )} every ${pricing.intervalCount} ${pricing.interval}(s)`
        );
        if (pricing.downpayment) {
          // Create downpayment with the interval of the duration. So, if the subscription renews in 6 months, then the downpayment should occur every 6 months
          const schedule = await this.getSchedule(orderLine.productVariant);
          const downpaymentInterval = schedule.durationInterval!;
          const downpaymentIntervalCount = schedule.durationCount!;
          const downpayment = await stripeClient.createOffSessionSubscription({
            customerId: stripeCustomerId,
            productId: product.id,
            currencyCode: order.currencyCode,
            amount: pricing.downpayment,
            interval: downpaymentInterval,
            intervalCount: downpaymentIntervalCount,
            paymentMethodId: stripePaymentMethodId,
            startDate: pricing.subscriptionStartDate,
            proration: false, // no proration for downpayments
            description: `Downpayment`,
          });
          Logger.info(
            `Created downpayment subscription for ${order.code}`,
            loggerCtx
          );
          await this.logOrderHistory(
            ctx,
            order.id,
            `Created downpayment subscription ${downpayment.id}: ${printMoney(
              pricing.downpayment
            )} every ${downpaymentIntervalCount} ${downpaymentInterval}(s)`
          );
        }
      } catch (e: unknown) {
        await this.logOrderHistory(
          ctx,
          order.id,
          `Failed to create subscriptions! Check your Stripe dashboard: ${
            (e as Error).message
          }`
        );
        throw e;
      }
    }
  }

  async createContext(channelToken: string): Promise<RequestContext> {
    const channel = await this.channelService.getChannelFromToken(channelToken);
    return new RequestContext({
      apiType: 'admin',
      isAuthorized: true,
      authorizedAsOwnerOnly: false,
      channel,
      languageCode: LanguageCode.en,
    });
  }

  async logOrderHistory(
    ctx: RequestContext,
    orderId: ID,
    message: string
  ): Promise<void> {
    await this.historyService.createHistoryEntryForOrder(
      {
        ctx,
        orderId,
        type: HistoryEntryType.ORDER_NOTE,
        data: {
          note: message,
        },
      },
      false
    );
  }

  /**
   * Get the paymentMethod with the stripe handler, should be only 1!
   */
  private async getStripeHandler(
    ctx: RequestContext,
    orderId: ID
  ): Promise<StripeHandlerConfig> {
    const paymentMethodQuotes =
      await this.orderService.getEligiblePaymentMethods(ctx, orderId);
    const paymentMethodQuote = paymentMethodQuotes.find(
      (pm) => pm.code.indexOf('stripe-subscription') > -1
    );
    if (!paymentMethodQuote) {
      throw Error(`No payment method found with code 'stripe-subscription'`);
    }
    const paymentMethod = await this.paymentMethodService.findOne(
      ctx,
      paymentMethodQuote.id
    );
    if (
      !paymentMethod ||
      paymentMethod.handler.code !== stripeSubscriptionHandler.code
    ) {
      throw Error(
        `Payment method '${paymentMethodQuote.code}' doesn't have handler '${stripeSubscriptionHandler.code}' configured.`
      );
    }
    const apiKey = paymentMethod.handler.args.find(
      (arg) => arg.name === 'apiKey'
    )?.value;
    let webhookSecret = paymentMethod.handler.args.find(
      (arg) => arg.name === 'webhookSecret'
    )?.value;
    if (!apiKey || !webhookSecret) {
      Logger.warn(
        `No api key or webhook secret is configured for ${paymentMethod.code}`,
        loggerCtx
      );
      throw Error(
        `Payment method ${paymentMethod.code} has no api key or webhook secret configured`
      );
    }
    return {
      paymentMethodCode: paymentMethod.code,
      stripeClient: new StripeClient(webhookSecret, apiKey, {
        apiVersion: null as any, // Null uses accounts default version
      }),
      webhookSecret,
      downpaymentLabel: paymentMethod.handler.args.find(
        (arg) => arg.name === 'downpaymentLabel'
      )?.value,
      prorationLabel: paymentMethod.handler.args.find(
        (arg) => arg.name === 'prorationLabel'
      )?.value,
    };
  }
}

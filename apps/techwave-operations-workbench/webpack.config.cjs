const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { BitableAppWebpackPlugin, opdevMiddleware } = require("@lark-opdev/block-bitable-webpack-utils");

module.exports = (_env, argv) => {
  process.env.NODE_ENV = argv.mode;
  const isDevelopment = argv.mode === "development";
  const businessDisplayName = process.env.BUSINESS_DISPLAY_NAME || "店铺经营";
  const storeAggregateLabel = process.env.STORE_AGGREGATE_LABEL || "店铺汇总";
  const roiTableName = process.env.ROI_TABLE_NAME || "投产比";
  return {
  entry: path.resolve(__dirname, "src/main.tsx"),
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "assets/[name].[contenthash:8].js",
    clean: true,
    publicPath: isDevelopment ? "/block/" : "./",
  },
  resolve: { extensions: [".tsx", ".ts", ".js"] },
  module: {
    rules: [
      { test: /\.tsx?$/, exclude: /node_modules/, use: { loader: "ts-loader", options: { transpileOnly: true } } },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      filename: "index.html",
      template: path.resolve(__dirname, "src/index.html"),
      publicPath: isDevelopment ? "/block/" : "./",
    }),
    new webpack.DefinePlugin({
      __BUSINESS_DISPLAY_NAME__: JSON.stringify(businessDisplayName),
      __STORE_AGGREGATE_LABEL__: JSON.stringify(storeAggregateLabel),
      __ROI_TABLE_NAME__: JSON.stringify(roiTableName),
    }),
    // Browser automation opens the target Base explicitly. Keep the dev server
    // from stealing focus by launching the user's default browser on rebuild.
    new BitableAppWebpackPlugin({ open: false }),
  ],
  devServer: {
    host: "127.0.0.1",
    port: 8080,
    hot: true,
    historyApiFallback: true,
    setupMiddlewares: (middlewares, devServer) => {
      devServer.app?.use((req, _res, next) => {
        if (req.url.startsWith("/api/") || req.url.startsWith("/block/")) {
          console.info(`[bitable-debug] ${req.method} ${req.url}`);
        }
        next();
      });
      middlewares.push(opdevMiddleware(devServer));
      return middlewares;
    },
  },
  devtool: "source-map",
  };
};
